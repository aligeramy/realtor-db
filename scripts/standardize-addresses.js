import { pool, db } from '../db/index.js';
import { logger } from '../utils/logger.js';
import { standardizeAddress, geocodeWithCache } from '../utils/geocoding.js';
import { eq, isNull, or } from 'drizzle-orm';
import { listings } from '../db/schema.drizzle.js';
import dotenv from 'dotenv';

dotenv.config();

// Config
const BATCH_SIZE = parseInt(process.env.ADDRESS_BATCH_SIZE || '100', 10);
const GEOCODE_ENABLED = process.env.ENABLE_GEOCODING === 'true';
const GEOCODE_DELAY_MS = parseInt(process.env.GEOCODE_DELAY_MS || '200', 10);
const TOTAL_LIMIT = parseInt(process.env.PROCESS_LIMIT || '0', 10);

/**
 * Sleep function to respect rate limits
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Process a batch of addresses for standardization and geocoding
 */
async function processAddressBatch(batchSize = BATCH_SIZE) {
  const client = await pool.connect();
  
  try {
    // First, check if we need to add the standardized_address column
    const checkColumnResult = await client.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'listings' AND column_name = 'standardized_address'
    `);
    
    if (checkColumnResult.rows.length === 0) {
      logger.info('Adding standardized_address column to listings table');
      await client.query(`ALTER TABLE listings ADD COLUMN standardized_address TEXT`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_listings_standardized_address ON listings(standardized_address)`);
    }
    
    // Get properties that need address standardization
    const query = `
      SELECT id, street_number, street_name, street_suffix, unit_number,
             city, province, postal_code, unparsed_address, latitude, longitude
      FROM listings
      WHERE standardized_address IS NULL
      ORDER BY id
      LIMIT $1
    `;
    
    const result = await client.query(query, [batchSize]);
    
    if (result.rows.length === 0) {
      logger.info('No properties found that need address standardization');
      return 0;
    }
    
    logger.info(`Processing ${result.rows.length} properties for address standardization`);
    
    let processed = 0;
    let geocoded = 0;
    
    // Process each property
    for (const property of result.rows) {
      try {
        // Create standardized address
        const standardAddress = standardizeAddress(property);
        
        if (!standardAddress) {
          logger.warn(`Unable to standardize address for property ${property.id}`);
          continue;
        }
        
        // Use direct SQL for updates instead of Drizzle ORM to avoid syntax errors
        const updateParams = [];
        let updateSql = 'UPDATE listings SET standardized_address = $1';
        updateParams.push(standardAddress);
        
        let paramCount = 1;
        
        // Geocode if needed and enabled
        if (GEOCODE_ENABLED && (!property.latitude || !property.longitude)) {
          // Add delay to respect API rate limits
          await sleep(GEOCODE_DELAY_MS);
          
          const { lat, lng } = await geocodeWithCache(standardAddress);
          
          if (lat && lng) {
            updateSql += `, latitude = $${++paramCount}, longitude = $${++paramCount}`;
            updateParams.push(lat);
            updateParams.push(lng);
            geocoded++;
          }
        }
        
        updateSql += ` WHERE id = $${++paramCount}`;
        updateParams.push(property.id);
        
        // Execute the update
        await client.query(updateSql, updateParams);
        
        processed++;
        
        // Log progress periodically
        if (processed % 10 === 0) {
          logger.info(`Processed ${processed}/${result.rows.length} properties, geocoded ${geocoded}`);
        }
        
      } catch (error) {
        logger.error(`Error processing property ${property.id}:`, error);
      }
    }
    
    logger.info(`Completed batch: ${processed} addresses standardized, ${geocoded} geocoded`);
    return processed;
  } catch (error) {
    logger.error('Error in address batch processing:', error);
    return 0;
  } finally {
    client.release();
  }
}

/**
 * Run continuous processing until all properties are standardized
 */
async function processAllAddresses() {
  logger.info('Starting address standardization process');
  
  let totalProcessed = 0;
  let batchesProcessed = 0;
  let continueProcessing = true;
  
  while (continueProcessing) {
    const processed = await processAddressBatch();
    
    // If we processed some properties, continue
    if (processed > 0) {
      totalProcessed += processed;
      batchesProcessed++;
      
      logger.info(`Completed batch ${batchesProcessed}, total processed: ${totalProcessed}`);
      
      // Check if we've reached the total limit
      if (TOTAL_LIMIT > 0 && totalProcessed >= TOTAL_LIMIT) {
        logger.info(`Reached processing limit of ${TOTAL_LIMIT}`);
        continueProcessing = false;
      }
    } else {
      // No more properties to process
      continueProcessing = false;
    }
  }
  
  logger.info(`Address standardization complete. Processed ${totalProcessed} properties in ${batchesProcessed} batches`);
  
  // Always close the connection at the end
  await pool.end();
}

// Run the process
processAllAddresses()
  .then(() => {
    logger.info('Address standardization process completed successfully');
    process.exit(0);
  })
  .catch(error => {
    logger.error('Error in address standardization process:', error);
    process.exit(1);
  }); 