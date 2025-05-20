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
// Updated rate limiting - Google Maps Platform typically allows 50 QPS
const GEOCODE_QPS = parseInt(process.env.GEOCODE_QPS || '50', 10); // Queries per second
const GEOCODE_DELAY_MS = Math.floor(1000 / GEOCODE_QPS); // Calculate delay based on QPS
const TOTAL_LIMIT = parseInt(process.env.PROCESS_LIMIT || '0', 10);

// Throttling mechanism for geocoding
class GeocodingThrottler {
  constructor(qps) {
    this.qps = qps;
    this.queue = [];
    this.processing = false;
    this.lastRequestTime = 0;
  }

  async geocode(address) {
    return new Promise((resolve) => {
      this.queue.push({ address, resolve });
      if (!this.processing) {
        this.processQueue();
      }
    });
  }

  async processQueue() {
    if (this.queue.length === 0) {
      this.processing = false;
      return;
    }

    this.processing = true;
    const { address, resolve } = this.queue.shift();
    
    // Calculate how long to wait to maintain QPS
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    const delay = Math.max(0, GEOCODE_DELAY_MS - elapsed);
    
    if (delay > 0) {
      await sleep(delay);
    }
    
    try {
      const result = await geocodeWithCache(address);
      this.lastRequestTime = Date.now();
      resolve(result);
    } catch (error) {
      logger.error(`Geocoding error for address ${address}:`, error);
      resolve({ lat: null, lng: null });
    }
    
    // Process next in queue
    setTimeout(() => this.processQueue(), 0);
  }
}

// Create throttler instance
const throttler = new GeocodingThrottler(GEOCODE_QPS);

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
    
    // Create processing batches to parallelize work while respecting rate limits
    const parallelBatchSize = Math.min(50, Math.max(5, GEOCODE_QPS)); // Safe parallelize amount
    const chunks = [];
    
    // Split properties into chunks for parallel processing
    for (let i = 0; i < result.rows.length; i += parallelBatchSize) {
      chunks.push(result.rows.slice(i, i + parallelBatchSize));
    }
    
    // Process chunks in sequence, but properties within chunks in parallel
    for (const chunk of chunks) {
      // Process each property in this chunk in parallel
      await Promise.all(chunk.map(async (property) => {
        try {
          // Create standardized address
          const standardAddress = standardizeAddress(property);
          
          if (!standardAddress) {
            logger.warn(`Unable to standardize address for property ${property.id}`);
            return;
          }
          
          // Use direct SQL for updates instead of Drizzle ORM to avoid syntax errors
          const updateParams = [];
          let updateSql = 'UPDATE listings SET standardized_address = $1';
          updateParams.push(standardAddress);
          
          let paramCount = 1;
          
          // Geocode if needed and enabled
          if (GEOCODE_ENABLED && (!property.latitude || !property.longitude)) {
            // Use the throttler for controlled geocoding
            const { lat, lng } = await throttler.geocode(standardAddress);
            
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
          if (processed % 100 === 0) {
            logger.info(`Processed ${processed}/${result.rows.length} properties, geocoded ${geocoded}`);
          }
        } catch (error) {
          logger.error(`Error processing property ${property.id}:`, error);
        }
      }));
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
 * @param {number} batchSize - Number of properties to process in each batch
 * @param {number} maxProperties - Maximum number of properties to process (0 = unlimited)
 * @returns {Object} - Results of the standardization process
 */
export async function runAddressStandardization(batchSize = BATCH_SIZE, maxProperties = 0) {
  logger.info('Starting address standardization process');
  
  let totalProcessed = 0;
  let batchesProcessed = 0;
  let continueProcessing = true;
  
  while (continueProcessing) {
    const processed = await processAddressBatch(batchSize);
    
    // If we processed some properties, continue
    if (processed > 0) {
      totalProcessed += processed;
      batchesProcessed++;
      
      logger.info(`Completed batch ${batchesProcessed}, total processed: ${totalProcessed}`);
      
      // Check if we've reached the custom max properties limit
      if (maxProperties > 0 && totalProcessed >= maxProperties) {
        logger.info(`Reached processing limit of ${maxProperties}`);
        continueProcessing = false;
      }
      // Check if we've reached the total limit from env
      else if (TOTAL_LIMIT > 0 && totalProcessed >= TOTAL_LIMIT) {
        logger.info(`Reached processing limit of ${TOTAL_LIMIT}`);
        continueProcessing = false;
      }
    } else {
      // No more properties to process
      continueProcessing = false;
    }
  }
  
  logger.info(`Address standardization complete. Processed ${totalProcessed} properties in ${batchesProcessed} batches`);
  
  return {
    processed: totalProcessed,
    batches: batchesProcessed
  };
}

/**
 * Standalone processing - only runs when script is executed directly
 */
async function processAllAddresses() {
  try {
    const result = await runAddressStandardization();
    
    // Close the pool connection when run as standalone
    await pool.end();
    
    return result;
  } catch (error) {
    logger.error('Error in address standardization process:', error);
    throw error;
  }
}

// Only run the process if this script is called directly
// ES Modules version of "if this file is run directly"
if (import.meta.url === `file://${process.argv[1]}`) {
  processAllAddresses()
    .then(() => {
      logger.info('Address standardization process completed successfully');
      process.exit(0);
    })
    .catch(error => {
      logger.error('Error in address standardization process:', error);
      process.exit(1);
    });
} 