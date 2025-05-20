import axios from 'axios';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';
import { pool } from '../db/index.js';

dotenv.config();

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const CACHE_SIZE = parseInt(process.env.GEOCODE_CACHE_SIZE || '10000', 10);
const REQUEST_TIMEOUT = parseInt(process.env.GEOCODING_TIMEOUT || '10000', 10);
const MAX_RETRIES = parseInt(process.env.GEOCODING_MAX_RETRIES || '3', 10);
const RETRY_DELAY = parseInt(process.env.GEOCODING_RETRY_DELAY || '2000', 10);
const CIRCUIT_THRESHOLD = parseInt(process.env.CIRCUIT_THRESHOLD || '5', 10);
const CIRCUIT_RESET_TIMEOUT = parseInt(process.env.CIRCUIT_RESET_TIMEOUT || '30000', 10);
const LOG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'logs');
const GEOCODING_LOG_FILE = path.join(LOG_DIR, 'geocoding.log');

// Create logs directory if it doesn't exist
try {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
} catch (error) {
  console.error('Error creating logs directory:', error);
}

// Circuit breaker implementation
class CircuitBreaker {
  constructor(options = {}) {
    this.state = 'CLOSED'; // CLOSED = normal, OPEN = failing, HALF_OPEN = testing
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = null;
    this.threshold = options.threshold || CIRCUIT_THRESHOLD;
    this.resetTimeout = options.resetTimeout || CIRCUIT_RESET_TIMEOUT;
  }

  async execute(fn) {
    // If circuit is open, check if we should try again
    if (this.state === 'OPEN') {
      if (Date.now() > this.lastFailureTime + this.resetTimeout) {
        // Move to half-open state and try the request
        this.state = 'HALF_OPEN';
        logger.info('Geocoding circuit breaker moving to HALF_OPEN state');
      } else {
        // Circuit still open, fast fail
        throw new Error('Circuit breaker open - geocoding service unavailable');
      }
    }

    try {
      // Execute the function
      const result = await fn();
      
      // If successful in half-open state, reset the circuit
      if (this.state === 'HALF_OPEN') {
        this.successCount++;
        
        // Reset after 2 successful requests
        if (this.successCount >= 2) {
          this.reset();
        }
      }
      
      return result;
    } catch (error) {
      // Record the failure
      this.failureCount++;
      this.lastFailureTime = Date.now();
      
      // If we hit the threshold, open the circuit
      if ((this.state === 'CLOSED' && this.failureCount >= this.threshold) || 
          (this.state === 'HALF_OPEN')) {
        this.state = 'OPEN';
        logger.warn(`Geocoding circuit breaker OPEN after ${this.failureCount} failures`);
      }
      
      throw error;
    }
  }

  reset() {
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.successCount = 0;
    logger.info('Geocoding circuit breaker reset to CLOSED state');
  }
}

// Create instance of circuit breaker
const geocodingCircuit = new CircuitBreaker();

/**
 * Standardize an address format using property fields
 */
export function standardizeAddress(property) {
  try {
    // Extract fields
    const {
      street_number,
      street_name,
      street_suffix,
      unit_number,
      city,
      province,
      postal_code
    } = property;
    
    // Build standardized address components
    const streetComponent = [
      street_number,
      street_name,
      street_suffix
    ].filter(Boolean).join(' ');
    
    const unitComponent = unit_number ? `Unit ${unit_number}` : '';
    
    const cityComponent = city || '';
    const provinceComponent = province || '';
    const postalComponent = postal_code ? postal_code.toUpperCase().replace(/\s+/g, '') : '';
    
    // Combine components to create standardized address
    const addressParts = [
      unitComponent,
      streetComponent,
      cityComponent,
      provinceComponent,
      postalComponent
    ].filter(Boolean);
    
    return addressParts.join(', ');
  } catch (error) {
    logger.error('Address standardization error:', error);
    return property.unparsed_address || '';
  }
}

/**
 * Advanced caching system for geocoding
 */
class GeocodingCache {
  constructor(maxSize) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.initialized = false;
    this.initializePromise = this.initializeCache();
    this.pendingRequests = new Map(); // For request deduplication
  }

  /**
   * Initialize cache from database
   */
  async initializeCache() {
    try {
      // Check if geocode_cache table exists, create if not
      const client = await pool.connect();
      try {
        const tableCheck = await client.query(`
          SELECT EXISTS (
            SELECT FROM information_schema.tables 
            WHERE table_name = 'geocode_cache'
          );
        `);
        
        if (!tableCheck.rows[0].exists) {
          logger.info('Creating geocode_cache table');
          await client.query(`
            CREATE TABLE geocode_cache (
              address TEXT PRIMARY KEY,
              latitude DOUBLE PRECISION,
              longitude DOUBLE PRECISION,
              created_at TIMESTAMP DEFAULT NOW(),
              last_accessed TIMESTAMP DEFAULT NOW(),
              access_count INTEGER DEFAULT 1
            );
            CREATE INDEX idx_geocode_cache_address ON geocode_cache(address);
          `);
        }
        
        // Load most recent addresses into memory cache
        const result = await client.query(`
          SELECT address, latitude, longitude
          FROM geocode_cache
          ORDER BY last_accessed DESC
          LIMIT $1
        `, [this.maxSize]);
        
        // Populate cache
        for (const row of result.rows) {
          this.cache.set(row.address, { 
            lat: row.latitude, 
            lng: row.longitude 
          });
        }
        
        logger.info(`Loaded ${this.cache.size} geocode entries from database`);
        this.initialized = true;
      } finally {
        client.release();
      }
    } catch (error) {
      logger.error('Error initializing geocode cache:', error);
      this.initialized = true; // Still mark as initialized to avoid blocking
    }
  }

  /**
   * Get from cache
   */
  async get(address) {
    // Wait for initialization to complete
    if (!this.initialized) {
      await this.initializePromise;
    }
    
    // Update database access stats in background (don't wait for it)
    const cachedValue = this.cache.get(address);
    if (cachedValue) {
      this.updateAccessStats(address).catch(err => 
        logger.error(`Failed to update geocode cache stats: ${err.message}`)
      );
    }
    
    return cachedValue;
  }

  /**
   * Store in cache and database
   */
  async set(address, coordinates) {
    // Wait for initialization to complete
    if (!this.initialized) {
      await this.initializePromise;
    }
    
    // Add to memory cache
    this.cache.set(address, coordinates);
    
    // Trim cache if needed
    if (this.cache.size > this.maxSize) {
      // Remove random 20% of entries (approximation for LRU)
      const keysToDelete = Array.from(this.cache.keys())
        .slice(0, Math.floor(this.maxSize * 0.2));
      
      for (const key of keysToDelete) {
        this.cache.delete(key);
      }
    }
    
    // Add to database asynchronously
    try {
      const client = await pool.connect();
      try {
        await client.query(`
          INSERT INTO geocode_cache (address, latitude, longitude)
          VALUES ($1, $2, $3)
          ON CONFLICT (address) DO UPDATE
          SET last_accessed = NOW(),
              access_count = geocode_cache.access_count + 1
        `, [address, coordinates.lat, coordinates.lng]);
      } finally {
        client.release();
      }
    } catch (error) {
      logger.error('Error storing geocode in database:', error);
    }
  }
  
  /**
   * Update access statistics for a cached address
   */
  async updateAccessStats(address) {
    try {
      const client = await pool.connect();
      try {
        await client.query(`
          UPDATE geocode_cache
          SET last_accessed = NOW(),
              access_count = access_count + 1
          WHERE address = $1
        `, [address]);
      } finally {
        client.release();
      }
    } catch (error) {
      // Just log, don't throw - this is background maintenance
      logger.debug(`Error updating geocode access stats: ${error.message}`);
    }
  }
  
  /**
   * Request deduplication for in-flight geocode requests
   */
  getPendingRequest(address) {
    return this.pendingRequests.get(address);
  }
  
  setPendingRequest(address, promise) {
    this.pendingRequests.set(address, promise);
    // Remove from pending requests once resolved
    promise.finally(() => {
      this.pendingRequests.delete(address);
    });
  }
}

// Create cache instance
const geocodeCache = new GeocodingCache(CACHE_SIZE);

/**
 * Log geocoding activity
 */
async function logGeocodingActivity(address, result, error = null) {
  try {
    const logEntry = {
      timestamp: new Date().toISOString(),
      address,
      success: !error,
      coords: error ? null : result,
      error: error ? error.message : null
    };
    
    await fs.appendFile(
      GEOCODING_LOG_FILE, 
      JSON.stringify(logEntry) + '\n'
    );
  } catch (logError) {
    logger.error(`Failed to log geocoding activity: ${logError.message}`);
  }
}

/**
 * Geocode an address using Google Maps API
 */
export async function geocodeAddress(address, retryCount = 0) {
  if (!GOOGLE_MAPS_API_KEY) {
    logger.warn('No Google Maps API key provided. Geocoding disabled.');
    return { lat: null, lng: null };
  }
  
  // Check cache first
  const cachedResult = await geocodeCache.get(address);
  if (cachedResult) {
    return cachedResult;
  }
  
  // Check for pending requests to avoid duplicate API calls
  const pendingRequest = geocodeCache.getPendingRequest(address);
  if (pendingRequest) {
    return pendingRequest;
  }
  
  // Create a new geocoding request promise
  const geocodePromise = geocodingCircuit.execute(async () => {
    try {
      const response = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
        params: {
          address,
          key: GOOGLE_MAPS_API_KEY
        },
        timeout: REQUEST_TIMEOUT
      });
      
      if (response.data.status === 'OK' && response.data.results.length > 0) {
        const { lat, lng } = response.data.results[0].geometry.location;
        const result = { lat, lng };
        
        // Store in cache
        await geocodeCache.set(address, result);
        
        // Log success
        await logGeocodingActivity(address, result);
        
        return result;
      }
      
      // Handle API-specific error cases
      if (response.data.status === 'OVER_QUERY_LIMIT' || response.data.status === 'RESOURCE_EXHAUSTED') {
        if (retryCount < MAX_RETRIES) {
          // Exponential backoff
          const delay = RETRY_DELAY * Math.pow(2, retryCount);
          logger.warn(`Geocoding rate limit for ${address}, retrying in ${delay}ms (${retryCount + 1}/${MAX_RETRIES})`);
          await new Promise(resolve => setTimeout(resolve, delay));
          return geocodeAddress(address, retryCount + 1);
        }
        
        // Max retries reached
        const error = new Error(`Geocoding rate limit exceeded: ${response.data.status}`);
        await logGeocodingActivity(address, null, error);
        throw error;
      }
      
      logger.warn(`Geocoding failed for address: ${address}. Status: ${response.data.status}`);
      await logGeocodingActivity(address, null, new Error(`API status: ${response.data.status}`));
      return { lat: null, lng: null };
    } catch (error) {
      // Handle network errors with retry
      if ((error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') && 
          retryCount < MAX_RETRIES) {
        // Exponential backoff for connection errors
        const delay = RETRY_DELAY * Math.pow(2, retryCount);
        logger.warn(`Geocoding connection error (${error.code}) for ${address}, retrying in ${delay}ms (${retryCount + 1}/${MAX_RETRIES})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return geocodeAddress(address, retryCount + 1);
      }
      
      // Log failure and rethrow
      await logGeocodingActivity(address, null, error);
      
      // For critical errors like invalid API key, we don't want to keep trying
      if (error.response && error.response.status === 403) {
        logger.error('Critical geocoding error (possible API key issue):', error);
        return { lat: null, lng: null }; // Return null coords but don't throw to avoid crashing
      }
      
      throw error;
    }
  });
  
  // Store pending request and return the promise
  geocodeCache.setPendingRequest(address, geocodePromise);
  return geocodePromise;
}

/**
 * Geocode with caching to reduce API calls
 */
export async function geocodeWithCache(address) {
  // This is a compatibility wrapper around the improved geocodeAddress function
  return geocodeAddress(address);
}

/**
 * Batch geocode multiple addresses with controlled concurrency
 */
export async function batchGeocodeAddresses(addresses, concurrency = 5) {
  const results = [];
  const batchSize = 50; // Process in smaller batches
  
  for (let i = 0; i < addresses.length; i += batchSize) {
    const batch = addresses.slice(i, i + batchSize);
    
    // Process batch with controlled concurrency
    const pendingPromises = [];
    const activePromises = new Set();
    
    for (const address of batch) {
      // Create promise for this address
      const promise = (async () => {
        try {
          const result = await geocodeAddress(address);
          return { address, result, success: true };
        } catch (error) {
          logger.error(`Failed to geocode address "${address}": ${error.message}`);
          return { address, result: null, success: false, error: error.message };
        } finally {
          activePromises.delete(promise);
          // Process next address in queue if available
          if (pendingPromises.length > 0) {
            const nextPromise = pendingPromises.shift();
            activePromises.add(nextPromise);
            nextPromise();
          }
        }
      })();
      
      // Either process now or queue for later
      if (activePromises.size < concurrency) {
        activePromises.add(promise);
      } else {
        pendingPromises.push(promise);
      }
      
      results.push(await promise);
    }
    
    // Wait for all promises in this batch to complete
    await Promise.all(Array.from(activePromises));
    
    // Add delay between batches to manage rate limits
    if (i + batchSize < addresses.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  return results;
} 