import express from 'express';
import { replicateAll } from '../services/sequential-replication.js';
import { discoverSchema, generateSchemaUpdateSQL } from '../services/schema-discovery.js';
import { getReplicationState, getStats, queryListings } from '../db/index.js';
import { db, pool } from '../db/index.js';
import { and, eq, gte, lte, desc, sql } from 'drizzle-orm';
import { listings } from '../db/schema.drizzle.js';
import { logger } from '../utils/logger.js';
import searchRoutes from './search-routes.js';

const router = express.Router();

// Mount search routes
router.use('/search', searchRoutes);

// Status endpoint with enhanced statistics
router.get('/status', async (req, res) => {
  try {
    // Get the current replication state
    const state = await getReplicationState();
    
    // Get database statistics
    const stats = await getStats();
    
    // Format response with additional information
    return res.json({
      status: 'ok',
      replication: {
        last_timestamp: state.lastTimestamp,
        last_key: state.lastKey,
        records_processed: state.recordsProcessed || 0,
        last_run_at: state.lastRunAt
      },
      database: {
        total_listings: parseInt(stats.total_listings, 10),
        oldest_listing: stats.oldest_listing,
        newest_listing: stats.newest_listing,
        listings_with_media: parseInt(stats.listings_with_media, 10),
        unique_cities: parseInt(stats.unique_cities, 10),
        unique_property_types: parseInt(stats.unique_property_types, 10)
      }
    });
  } catch (error) {
    logger.error('Error in status endpoint:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Trigger replication manually with better progress reporting
router.post('/replicate', async (req, res) => {
  try {
    // Respond immediately to client
    res.json({ status: 'replication_started' });
    
    // Start replication in the background
    replicateAll()
      .then(result => {
        logger.info(`Replication completed: ${result.properties.processed} properties and ${result.media.mediaProcessed} media items`);
      })
      .catch(error => {
        logger.error('Manual replication failed:', error);
      });
  } catch (error) {
    logger.error('Error starting replication:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Discover and update schema
router.post('/discover-schema', async (req, res) => {
  try {
    // Discover schema
    const schema = await discoverSchema();
    
    // Generate SQL for schema updates
    const sql = generateSchemaUpdateSQL(schema);
    
    // Execute SQL if not empty
    if (sql) {
      await pool.query(sql);
      logger.info('Schema updated successfully');
    }
    
    return res.json({
      status: 'success',
      properties_count: schema.properties.length,
      sql_executed: sql ? true : false
    });
  } catch (error) {
    logger.error('Error in schema discovery:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Get a specific listing using Drizzle
router.get('/listings/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Query using Drizzle ORM for type safety
    const result = await db.select()
      .from(listings)
      .where(eq(listings.id, id))
      .limit(1);
    
    if (result.length === 0) {
      return res.status(404).json({ error: 'Listing not found' });
    }
    
    return res.json(result[0]);
  } catch (error) {
    logger.error(`Error getting listing ${req.params.id}:`, error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Search listings with improved filtering using Drizzle
router.get('/listings', async (req, res) => {
  try {
    const { 
      city, 
      property_type, 
      min_price, 
      max_price,
      min_bedrooms,
      province,
      status,
      limit = 20,
      offset = 0
    } = req.query;
    
    // Build conditions array for cleaner filtering
    const conditions = [];
    
    if (city) {
      conditions.push(eq(listings.city, city));
    }
    
    if (property_type) {
      conditions.push(eq(listings.propertyType, property_type));
    }
    
    if (min_price) {
      conditions.push(gte(listings.listPrice, parseFloat(min_price)));
    }
    
    if (max_price) {
      conditions.push(lte(listings.listPrice, parseFloat(max_price)));
    }
    
    if (min_bedrooms) {
      conditions.push(gte(listings.bedroomsTotal, parseInt(min_bedrooms, 10)));
    }
    
    if (province) {
      conditions.push(eq(listings.province, province));
    }
    
    if (status) {
      conditions.push(eq(listings.standardStatus, status));
    }
    
    // Combine conditions with AND
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    
    // Get count for pagination
    const countResult = await db
      .select({ count: sql`COUNT(*)` })
      .from(listings)
      .where(whereClause);
      
    const totalCount = parseInt(countResult[0].count.toString(), 10);
    
    // Get actual results
    const result = await db
      .select()
      .from(listings)
      .where(whereClause)
      .orderBy(desc(listings.modificationTimestamp))
      .limit(parseInt(limit, 10))
      .offset(parseInt(offset, 10));
    
    // Prepare pagination info
    return res.json({
      total: totalCount,
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10),
      listings: result
    });
  } catch (error) {
    logger.error('Error searching listings:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Get listing statistics for analytics
router.get('/analytics/summary', async (req, res) => {
  try {
    // Get statistics grouped by property type
    const typeStats = await db
      .select({
        property_type: listings.propertyType,
        count: sql`COUNT(*)`,
        avg_price: sql`AVG(list_price)`,
        min_price: sql`MIN(list_price)`,
        max_price: sql`MAX(list_price)`
      })
      .from(listings)
      .groupBy(listings.propertyType);
    
    // Get statistics grouped by city
    const cityStats = await db
      .select({
        city: listings.city,
        count: sql`COUNT(*)`,
        avg_price: sql`AVG(list_price)`,
        min_price: sql`MIN(list_price)`,
        max_price: sql`MAX(list_price)`
      })
      .from(listings)
      .groupBy(listings.city)
      .orderBy(sql`COUNT(*)`, 'desc')
      .limit(10); // Top 10 cities
    
    return res.json({
      by_property_type: typeStats,
      by_city: cityStats
    });
  } catch (error) {
    logger.error('Error getting analytics summary:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router; 