import { pool } from '../../db/index.js';
import { logger } from '../../utils/logger.js';

async function createSearchIndexes() {
  const client = await pool.connect();
  
  try {
    logger.info('Creating search indexes...');
    
    // First, check if standardized_address column exists, if not add it
    const checkColumnResult = await client.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'listings' AND column_name = 'standardized_address'
    `);
    
    if (checkColumnResult.rows.length === 0) {
      logger.info('Adding standardized_address column to listings table');
      await client.query(`ALTER TABLE listings ADD COLUMN standardized_address TEXT`);
    }
    
    // Create or replace GIN index for full-text search on address fields
    logger.info('Creating GIN index for address text search');
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_listings_address_tsvector 
      ON listings 
      USING GIN (to_tsvector('english', 
        COALESCE(standardized_address, '') || ' ' || 
        COALESCE(unparsed_address, '') || ' ' || 
        COALESCE(city, '') || ' ' || 
        COALESCE(province, '') || ' ' || 
        COALESCE(postal_code, '')
      ));
    `);
    
    // Create or replace GIN index for full-text search on property features
    logger.info('Creating GIN index for property features text search');
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_listings_features_tsvector 
      ON listings 
      USING GIN (to_tsvector('english', 
        COALESCE(property_type, '') || ' ' || 
        COALESCE(public_remarks, '')
      ));
    `);
    
    // Create index on standardized_address
    logger.info('Creating index on standardized_address');
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_listings_standardized_address 
      ON listings(standardized_address);
    `);
    
    // Add spatial index for geo-queries if PostGIS extension is available
    const checkPostGIS = await client.query(`
      SELECT 1 FROM pg_extension WHERE extname = 'postgis'
    `);
    
    if (checkPostGIS.rows.length > 0) {
      logger.info('PostGIS extension found, creating spatial index');
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_listings_location 
        ON listings 
        USING GIST (ST_SetSRID(ST_MakePoint(longitude, latitude), 4326));
      `);
    } else {
      logger.warn('PostGIS extension not found, skipping spatial index creation');
      logger.warn('Consider installing PostGIS with: CREATE EXTENSION postgis;');
      
      // Create regular indices for latitude and longitude
      logger.info('Creating regular indices for latitude and longitude');
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_listings_latitude ON listings(latitude);
        CREATE INDEX IF NOT EXISTS idx_listings_longitude ON listings(longitude);
      `);
    }
    
    logger.info('All search indexes created successfully');
  } catch (error) {
    logger.error('Error creating search indexes:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

// Run the function
createSearchIndexes()
  .then(() => {
    logger.info('Search indexes creation completed');
    process.exit(0);
  })
  .catch(error => {
    logger.error('Failed to create search indexes:', error);
    process.exit(1);
  }); 