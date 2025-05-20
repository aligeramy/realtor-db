#!/usr/bin/env node

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import pLimit from 'p-limit';
import { pool } from '../db/index.js';
import { logger, geocodingLogger } from '../utils/logger.js';
import { geocodeAddress, batchGeocodeAddresses } from '../utils/geocoding.js';

// Load environment variables
dotenv.config();

// Configuration
const BATCH_SIZE = parseInt(process.env.ADDRESS_BATCH_SIZE || '500', 10);
const MAX_BATCHES = parseInt(process.env.ADDRESS_MAX_BATCHES || '10', 10);
const CONCURRENCY = parseInt(process.env.GEOCODING_CONCURRENCY || '5', 10);
const ENABLE_GEOCODING = process.env.ENABLE_GEOCODING === 'true';
const ERROR_RETRY_DELAY = 30000; // 30 seconds
const MIN_BATCH_DELAY = 1000; // 1 second

// Set up geocode cache table if it doesn't exist
async function setupGeocodeCache() {
  const client = await pool.connect();
  try {
    // Check if geocode_cache table exists
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
          last_access TIMESTAMP DEFAULT NOW(),
          access_count INTEGER DEFAULT 1
        );
        CREATE INDEX idx_geocode_cache_address ON geocode_cache(address);
      `);
    } else {
      // Check if the columns exist, add them if they don't
      const columnCheck = await client.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.columns 
          WHERE table_name = 'geocode_cache' AND column_name = 'last_access'
        );
      `);
      
      if (!columnCheck.rows[0].exists) {
        logger.info('Adding missing columns to geocode_cache table');
        await client.query(`
          ALTER TABLE geocode_cache ADD COLUMN IF NOT EXISTS last_access TIMESTAMP DEFAULT NOW();
          ALTER TABLE geocode_cache ADD COLUMN IF NOT EXISTS access_count INTEGER DEFAULT 1;
        `);
      }
    }
    
    logger.info('Geocode cache setup complete');
    return true;
  } catch (error) {
    logger.error(`Failed to set up geocode cache: ${error.message}`);
    return false;
  } finally {
    client.release();
  }
}

/**
 * Get properties that need address standardization
 */
async function getUnstandardizedProperties(limit, offset = 0) {
  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT 
        id as "propertyKey", 
        unparsed_address, 
        street_number,
        street_name, 
        street_suffix,
        unit_number, 
        city, 
        province as "province", 
        postal_code, 
        country
      FROM listings
      WHERE addressStandardized IS NOT TRUE
      AND standard_status IN ('Active', 'Pending', 'Coming Soon', 'New')
      ORDER BY id
      LIMIT $1 OFFSET $2
    `, [limit, offset]);
    
    return result.rows;
  } catch (error) {
    logger.error(`Failed to fetch unstandardized properties: ${error.message}`);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Build complete address from property fields
 */
function buildCompleteAddress(property) {
  // Extract address components
  const components = [
    property.street_number,
    property.street_name,
    property.street_suffix
  ].filter(Boolean).join(' ');
  
  const unit = property.unit_number ? `Unit ${property.unit_number}, ` : '';
  const city = property.city || '';
  const province = property.province || '';
  const postalCode = property.postal_code || '';
  const country = property.country || 'Canada';
  
  // If we have an unparsed address and components are missing, use the unparsed address
  if ((!components || components.trim() === '') && property.unparsed_address) {
    return [
      property.unparsed_address,
      city,
      province,
      postalCode,
      country
    ].filter(Boolean).join(', ');
  }
  
  // Otherwise use the components
  return [
    unit + components,
    city,
    province,
    postalCode,
    country
  ].filter(Boolean).join(', ');
}

/**
 * Standardize and geocode a single address
 */
async function standardizeAndGeocodeAddress(property) {
  const client = await pool.connect();
  try {
    const fullAddress = buildCompleteAddress(property);
    
    if (!fullAddress || fullAddress.trim() === '') {
      logger.warn(`Cannot standardize property ${property.propertyKey}: insufficient address data`);
      
      // Mark as standardized but without geocoding to avoid reprocessing
      await client.query(`
        UPDATE listings
        SET addressStandardized = TRUE,
            geocodingFailed = TRUE,
            formattedAddress = $1
        WHERE id = $2
      `, [property.unparsed_address || '', property.propertyKey]);
      
      return { status: 'skipped', propertyKey: property.propertyKey };
    }
    
    // Skip geocoding if disabled
    if (!ENABLE_GEOCODING) {
      await client.query(`
        UPDATE listings
        SET addressStandardized = TRUE,
            formattedAddress = $1
        WHERE id = $2
      `, [fullAddress, property.propertyKey]);
      
      return { status: 'standardized', propertyKey: property.propertyKey, address: fullAddress };
    }
    
    // Get geocode data
    const geocodeResult = await geocodeAddress(fullAddress);
    
    if (!geocodeResult || (!geocodeResult.lat && !geocodeResult.lng)) {
      logger.warn(`Geocoding failed for property ${property.propertyKey}: ${fullAddress}`);
      
      // Mark as standardized but with geocoding failed
      await client.query(`
        UPDATE listings
        SET addressStandardized = TRUE,
            geocodingFailed = TRUE,
            formattedAddress = $1
        WHERE id = $2
      `, [fullAddress, property.propertyKey]);
      
      return { status: 'geocode_failed', propertyKey: property.propertyKey, address: fullAddress };
    }
    
    // Update property with standardized address and geocode data
    await client.query(`
      UPDATE listings
      SET addressStandardized = TRUE,
          geocodingFailed = FALSE,
          formattedAddress = $1,
          latitude = $2,
          longitude = $3
      WHERE id = $4
    `, [fullAddress, geocodeResult.lat, geocodeResult.lng, property.propertyKey]);
    
    return {
      status: 'geocoded',
      propertyKey: property.propertyKey,
      address: fullAddress,
      lat: geocodeResult.lat,
      lng: geocodeResult.lng
    };
  } catch (error) {
    geocodingLogger.error(`Error standardizing property ${property.propertyKey}: ${error.message}`);
    
    // If this is a serious error like circuit breaker open, we should stop processing
    if (error.message && error.message.includes('Circuit breaker open')) {
      client.release();
      throw error;
    }
    
    // For other errors, mark the property as failed but don't stop processing
    try {
      await client.query(`
        UPDATE listings
        SET geocodingFailed = TRUE
        WHERE id = $1
      `, [property.propertyKey]);
    } catch (dbError) {
      logger.error(`Failed to update geocoding failed status: ${dbError.message}`);
    }
    
    return { status: 'error', propertyKey: property.propertyKey, error: error.message };
  } finally {
    client.release();
  }
}

/**
 * Process a batch of properties
 */
async function processBatch(properties, concurrency = CONCURRENCY) {
  try {
    const limit = pLimit(concurrency);
    const results = { total: 0, geocoded: 0, standardized: 0, failed: 0, skipped: 0 };
    
    // Process properties in chunks to avoid overwhelming the database
    const CHUNK_SIZE = 25;
    
    for (let i = 0; i < properties.length; i += CHUNK_SIZE) {
      const chunk = properties.slice(i, i + CHUNK_SIZE);
      
      // Process each property in the chunk with concurrency limit
      const chunkPromises = chunk.map(property => {
        return limit(() => standardizeAndGeocodeAddress(property));
      });
      
      // Wait for all properties in this chunk to finish
      const chunkResults = await Promise.all(chunkPromises);
      
      // Aggregate results
      for (const result of chunkResults) {
        results.total++;
        
        if (result.status === 'geocoded') {
          results.geocoded++;
        } else if (result.status === 'standardized') {
          results.standardized++;
        } else if (result.status === 'skipped') {
          results.skipped++;
        } else {
          results.failed++;
        }
      }
      
      // Log progress for this chunk
      logger.info(`Processed ${i + chunk.length}/${properties.length} properties in current batch`);
      
      // Small delay between chunks to avoid API rate limits
      if (i + CHUNK_SIZE < properties.length) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
    
    return results;
  } catch (error) {
    // If this is a circuit breaker error, we should stop processing completely
    if (error.message && error.message.includes('Circuit breaker open')) {
      logger.error(`Geocoding service unavailable: ${error.message}`);
      throw error;
    }
    
    logger.error(`Error processing batch: ${error.message}`);
    return { total: properties.length, geocoded: 0, standardized: 0, failed: properties.length, skipped: 0 };
  }
}

/**
 * Main function to standardize addresses
 */
export async function standardizeAddresses(options = {}) {
  const batchSize = options.batchSize || BATCH_SIZE;
  const maxBatches = options.maxBatches || MAX_BATCHES;
  const concurrency = options.concurrency || CONCURRENCY;
  
  logger.info('Starting address standardization process');
  
  // Initialize geocode cache
  const cacheSetup = await setupGeocodeCache();
  if (!cacheSetup) {
    logger.warn('Failed to set up geocode cache, continuing without cache');
  }
  
  // Initialize counters
  let offset = 0;
  let batchCount = 0;
  let totalProcessed = 0;
  let totalGeocoded = 0;
  let totalFailed = 0;
  let totalSkipped = 0;
  let totalStandardized = 0;
  
  // Get count of properties needing standardization
  const client = await pool.connect();
  let totalCount = 0;
  
  try {
    const countResult = await client.query(`
      SELECT COUNT(*) 
      FROM listings 
      WHERE addressStandardized IS NOT TRUE
      AND standard_status IN ('Active', 'Pending', 'Coming Soon', 'New')
    `);
    totalCount = parseInt(countResult.rows[0].count, 10);
  } finally {
    client.release();
  }
  
  logger.info(`Processing ${totalCount} properties for address standardization`);
  
  try {
    while (batchCount < maxBatches) {
      // Get a batch of properties
      const properties = await getUnstandardizedProperties(batchSize, offset);
      
      if (properties.length === 0) {
        logger.info('No more properties to process');
        break;
      }
      
      logger.info(`Processing batch ${batchCount + 1}: ${properties.length} properties`);
      
      try {
        // Process this batch
        const results = await processBatch(properties, concurrency);
        
        // Update counters
        totalProcessed += results.total;
        totalGeocoded += results.geocoded;
        totalStandardized += results.standardized;
        totalFailed += results.failed;
        totalSkipped += results.skipped;
        
        logger.info(`Completed batch: ${properties.length} addresses standardized, ${results.geocoded} geocoded, ${results.failed} failed, ${results.skipped} skipped`);
      } catch (batchError) {
        // If this is a circuit breaker error, wait and then continue
        if (batchError.message && batchError.message.includes('Circuit breaker open')) {
          logger.warn(`Geocoding service unavailable, waiting ${ERROR_RETRY_DELAY/1000} seconds before next batch`);
          await new Promise(resolve => setTimeout(resolve, ERROR_RETRY_DELAY));
        } else {
          logger.error(`Batch ${batchCount + 1} failed: ${batchError.message}`);
        }
      }
      
      // Increment counters
      offset += properties.length;
      batchCount++;
      
      // Log progress
      logger.info(`Completed batch ${batchCount}, total processed: ${totalProcessed}`);
      
      // Check if we've reached the processing limit
      if (offset >= totalCount || properties.length < batchSize) {
        logger.info('Completed processing all unstandardized properties');
        break;
      }
      
      // Add a delay between batches to prevent overwhelming the geocoding API
      await new Promise(resolve => setTimeout(resolve, MIN_BATCH_DELAY));
    }
    
    if (batchCount >= maxBatches) {
      logger.info(`Reached processing limit of ${batchSize * maxBatches}`);
    }
    
    logger.info(`Address standardization complete. Processed ${totalProcessed} properties in ${batchCount} batches`);
    logger.info(`Results: ${totalGeocoded} geocoded, ${totalStandardized} standardized without geocoding, ${totalFailed} failed, ${totalSkipped} skipped`);
    
    return {
      totalProcessed,
      totalGeocoded,
      totalStandardized,
      totalFailed,
      totalSkipped,
      batchCount
    };
  } catch (error) {
    logger.error(`Address standardization failed: ${error.message}`);
    throw error;
  }
}

// If this script is run directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  standardizeAddresses({ batchSize: 10, maxBatches: 1, enableGeocoding: false })
    .then(result => {
      console.log(`Address standardization completed. Processed ${result.totalProcessed} properties in ${result.batchCount} batches.`);
      process.exit(0);
    })
    .catch(error => {
      console.error(`Error during address standardization: ${error.message}`);
      process.exit(1);
    });
}

export default standardizeAddresses; 