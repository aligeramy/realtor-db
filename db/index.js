import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import { drizzle } from 'drizzle-orm/node-postgres';
import { logger } from '../utils/logger.js';

dotenv.config();

// Get directory of current module
const __dirname = dirname(fileURLToPath(import.meta.url));

// Get connection config from environment variables
const getConnectionConfig = () => {
  try {
    return {
      host: process.env.POSTGRES_HOST || '198.251.68.5',
      port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
      database: process.env.POSTGRES_DB || 'listings',
      user: process.env.POSTGRES_USER || 'pooya',
      password: process.env.POSTGRES_PASSWORD || 'hR72fW9nTqZxB3dMvgKpY1CsJeULoXNb',
      ssl: false
    };
  } catch (error) {
    logger.error('Error getting connection config:', error);
    throw error;
  }
};

// Create connection pool with improved config
const createPool = () => {
  try {
    const config = getConnectionConfig();
    
    return new pg.Pool({
      user: config.user,
      password: config.password,
      host: config.host,
      port: config.port,
      database: config.database,
      ssl: config.ssl ? { rejectUnauthorized: false } : false,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
  } catch (error) {
    logger.error('Failed to create database pool:', error);
    throw error;
  }
};

// DB connection pool
const pool = createPool();

// Make pool available globally for use in other modules
global.pool = pool;

// Create Drizzle ORM instance
const db = drizzle(pool);

// Test connection with improved error handling
const testConnection = async () => {
  let client;
  try {
    client = await pool.connect();
    const result = await client.query('SELECT NOW()');
    logger.info(`Database connected successfully at ${result.rows[0].now}`);
    return true;
  } catch (error) {
    logger.error('Database connection error:', error);
    throw error;
  } finally {
    if (client) client.release();
  }
};

// Initialize connection immediately
testConnection().catch(err => {
  logger.error('Initial database connection failed:', err);
  process.exit(1);
});

// Initialize the database schema with transaction support
export const initDatabase = async () => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const schemaPath = join(__dirname, 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');
    
    await client.query(schema);
    logger.info('Database schema initialized successfully');
    
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Failed to initialize database schema:', error);
    throw error;
  } finally {
    client.release();
  }
};

// Get replication state with improved error handling
export const getReplicationState = async (resourceName = 'Property') => {
  const client = await pool.connect();
  
  try {
    const result = await client.query(
      'SELECT last_timestamp, last_key, records_processed FROM replication_state WHERE resource_name = $1',
      [resourceName]
    );
    
    if (result.rows.length === 0) {
      // Insert initial state if none exists
      await client.query(
        'INSERT INTO replication_state (resource_name, last_timestamp, last_key, records_processed) VALUES ($1, $2, $3, $4)',
        [resourceName, '1970-01-01T00:00:00Z', '0', 0]
      );
      
      return { 
        lastTimestamp: '1970-01-01T00:00:00Z', 
        lastKey: '0',
        recordsProcessed: 0 
      };
    }
    
    return {
      lastTimestamp: result.rows[0].last_timestamp,
      lastKey: result.rows[0].last_key,
      recordsProcessed: parseInt(result.rows[0].records_processed, 10) || 0
    };
  } catch (error) {
    logger.error('Failed to get replication state:', error);
    throw error;
  } finally {
    client.release();
  }
};

// Update replication state with record count tracking
export const updateReplicationState = async (resourceName, lastTimestamp, lastKey, recordsProcessed = 0) => {
  const client = await pool.connect();
  
  try {
    // Get current records processed count if it exists
    const currentState = await client.query(
      'SELECT records_processed FROM replication_state WHERE resource_name = $1',
      [resourceName]
    );
    
    let totalRecordsProcessed = recordsProcessed;
    
    // If we have a current count, add to it rather than replacing it
    if (currentState.rows.length > 0 && currentState.rows[0].records_processed) {
      const currentCount = parseInt(currentState.rows[0].records_processed, 10) || 0;
      // Only add the new records to the total if recordsProcessed is provided
      if (recordsProcessed > 0) {
        totalRecordsProcessed = currentCount + recordsProcessed;
      } else {
        totalRecordsProcessed = currentCount;
      }
    }
    
    await client.query(
      `UPDATE replication_state 
       SET last_timestamp = $1, last_key = $2, records_processed = $3, last_run_at = NOW() 
       WHERE resource_name = $4`,
      [lastTimestamp, lastKey, totalRecordsProcessed, resourceName]
    );
    
    logger.debug(`Updated replication state: [${resourceName}] timestamp=${lastTimestamp}, key=${lastKey}, count=${totalRecordsProcessed}`);
  } catch (error) {
    logger.error('Failed to update replication state:', error);
    throw error;
  } finally {
    client.release();
  }
};

// Insert or update listing with optimized query
export const upsertListing = async (listing) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Extract fields and values for dynamic query building
    const fields = Object.keys(listing).filter(key => key !== 'raw');
    const values = fields.map(field => listing[field]);
    
    // Add raw JSON field separately to avoid conversion issues
    fields.push('raw');
    values.push(JSON.stringify(listing.raw));
    
    // Build the parametrized query dynamically
    const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
    const updateAssignments = fields
      .map((field, i) => `${field} = $${i + 1}`)
      .join(', ');
    const insertFields = fields.join(', ');
    
    // Use a more efficient upsert pattern
    const query = `
      INSERT INTO listings (${insertFields})
      VALUES (${placeholders})
      ON CONFLICT (id) 
      DO UPDATE SET 
        ${updateAssignments},
        updated_at = NOW()
    `;
    
    await client.query(query, values);
    await client.query('COMMIT');
    
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(`Failed to upsert listing ${listing.id}:`, error);
    throw error;
  } finally {
    client.release();
  }
};

// Insert or update media with optimized query
export const upsertMedia = async (media) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Extract fields and values for dynamic query building
    const fields = Object.keys(media);
    const values = fields.map(field => media[field]);
    
    // Build the parametrized query dynamically
    const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
    const updateAssignments = fields
      .filter(field => field !== 'media_key') // Exclude primary key from updates
      .map((field, i) => `${field} = $${fields.indexOf(field) + 1}`)
      .join(', ');
    const insertFields = fields.join(', ');
    
    // Use a more efficient upsert pattern
    const query = `
      INSERT INTO listing_media (${insertFields})
      VALUES (${placeholders})
      ON CONFLICT (media_key) 
      DO UPDATE SET 
        ${updateAssignments},
        updated_at = NOW()
    `;
    
    await client.query(query, values);
    await client.query('COMMIT');
    
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(`Failed to upsert media ${media.media_key}:`, error);
    throw error;
  } finally {
    client.release();
  }
};

// Query listings with improved filtering
export const queryListings = async ({ 
  city, propertyType, minPrice, maxPrice, minBedrooms, limit = 20, offset = 0
}) => {
  const client = await pool.connect();
  
  try {
    // Build query conditions and parameters
    const conditions = [];
    const params = [];
    
    if (city) {
      params.push(city);
      conditions.push(`city = $${params.length}`);
    }
    
    if (propertyType) {
      params.push(propertyType);
      conditions.push(`property_type = $${params.length}`);
    }
    
    if (minPrice) {
      params.push(parseFloat(minPrice));
      conditions.push(`list_price >= $${params.length}`);
    }
    
    if (maxPrice) {
      params.push(parseFloat(maxPrice));
      conditions.push(`list_price <= $${params.length}`);
    }
    
    if (minBedrooms) {
      params.push(parseInt(minBedrooms, 10));
      conditions.push(`bedrooms_total >= $${params.length}`);
    }
    
    // Build the query
    let query = 'SELECT * FROM listings';
    
    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }
    
    // Add limiting and sorting
    params.push(parseInt(limit, 10));
    query += ` ORDER BY modification_timestamp DESC LIMIT $${params.length}`;
    
    params.push(parseInt(offset, 10));
    query += ` OFFSET $${params.length}`;
    
    // Execute query
    const result = await client.query(query, params);
    
    // Count total results
    let countQuery = 'SELECT COUNT(*) FROM listings';
    
    if (conditions.length > 0) {
      countQuery += ' WHERE ' + conditions.join(' AND ');
    }
    
    const countResult = await client.query(countQuery, params.slice(0, -2));
    
    return {
      total: parseInt(countResult.rows[0].count, 10),
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10),
      listings: result.rows
    };
  } catch (error) {
    logger.error('Failed to query listings:', error);
    throw error;
  } finally {
    client.release();
  }
};

// Get database statistics for monitoring
export const getStats = async () => {
  const client = await pool.connect();
  
  try {
    const result = await client.query(`
      SELECT 
        COUNT(*) as total_listings,
        MIN(modification_timestamp) as oldest_listing,
        MAX(modification_timestamp) as newest_listing,
        COUNT(CASE WHEN media_keys IS NOT NULL AND array_length(media_keys, 1) > 0 THEN 1 END) as listings_with_media,
        COUNT(DISTINCT city) as unique_cities,
        COUNT(DISTINCT property_type) as unique_property_types
      FROM listings
    `);
    
    return result.rows[0];
  } catch (error) {
    logger.error('Failed to get database statistics:', error);
    throw error;
  } finally {
    client.release();
  }
};

// Check if a listing exists in the database
export const isListingInDatabase = async (listingId) => {
  const client = await pool.connect();
  
  try {
    const result = await client.query(
      'SELECT 1 FROM listings WHERE id = $1 LIMIT 1',
      [listingId]
    );
    
    return result.rows.length > 0;
  } catch (error) {
    logger.error(`Failed to check if listing ${listingId} exists:`, error);
    throw error;
  } finally {
    client.release();
  }
};

export { db, pool };
export default db; 