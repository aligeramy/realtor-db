import axios from 'axios';
import dotenv from 'dotenv';
import { logger } from './logger.js';
import { pool } from '../db/index.js';

dotenv.config();

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const CACHE_SIZE = parseInt(process.env.GEOCODE_CACHE_SIZE || '10000', 10);

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
              created_at TIMESTAMP DEFAULT NOW()
            );
            CREATE INDEX idx_geocode_cache_address ON geocode_cache(address);
          `);
        }
        
        // Load most recent addresses into memory cache
        const result = await client.query(`
          SELECT address, latitude, longitude
          FROM geocode_cache
          ORDER BY created_at DESC
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
    return this.cache.get(address);
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
          ON CONFLICT (address) DO NOTHING
        `, [address, coordinates.lat, coordinates.lng]);
      } finally {
        client.release();
      }
    } catch (error) {
      logger.error('Error storing geocode in database:', error);
    }
  }
}

// Create cache instance
const geocodeCache = new GeocodingCache(CACHE_SIZE);

/**
 * Geocode an address using Google Maps API
 */
export async function geocodeAddress(address) {
  if (!GOOGLE_MAPS_API_KEY) {
    logger.warn('No Google Maps API key provided. Geocoding disabled.');
    return { lat: null, lng: null };
  }
  
  try {
    const response = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
      params: {
        address,
        key: GOOGLE_MAPS_API_KEY
      }
    });
    
    if (response.data.status === 'OK' && response.data.results.length > 0) {
      const { lat, lng } = response.data.results[0].geometry.location;
      return { lat, lng };
    }
    
    logger.warn(`Geocoding failed for address: ${address}. Status: ${response.data.status}`);
    return { lat: null, lng: null };
  } catch (error) {
    logger.error('Geocoding error:', error);
    return { lat: null, lng: null };
  }
}

/**
 * Geocode with caching to reduce API calls
 */
export async function geocodeWithCache(address) {
  // Check if result is already in cache
  const cachedResult = await geocodeCache.get(address);
  if (cachedResult) {
    return cachedResult;
  }
  
  // Call the geocoding API
  const result = await geocodeAddress(address);
  
  // Store in cache if coordinates were found
  if (result.lat && result.lng) {
    await geocodeCache.set(address, result);
  }
  
  return result;
} 