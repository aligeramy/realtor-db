import express from 'express';
import { pool, db } from '../db/index.js';
import { eq, like, and, or, gte, lte, desc, sql } from 'drizzle-orm';
import { listings } from '../db/schema.drizzle.js';
import { logger } from '../utils/logger.js';
import { geocodeWithCache } from '../utils/geocoding.js';

const router = express.Router();

/**
 * Main search endpoint with full-text search and spatial capabilities
 */
router.get('/search', async (req, res) => {
  try {
    const { 
      query,            // Text search
      location,         // Location search (address or postal code)
      radius = 10,      // Search radius in km (default 10km)
      minPrice, 
      maxPrice,
      bedrooms,
      bathrooms,
      propertyType,
      city,
      province,
      limit = 20,
      offset = 0
    } = req.query;
    
    // Determine if we need PostgreSQL full-text search
    const needsTextSearch = query && query.trim().length > 0;
    
    // Determine if we need spatial search
    const needsSpatialSearch = location && location.trim().length > 0 && radius;
    
    // Use raw SQL for complex queries with text search and spatial functions
    if (needsTextSearch || needsSpatialSearch) {
      const client = await pool.connect();
      
      try {
        // Build conditions and parameters
        const conditions = [];
        const params = [];
        
        // Text search condition
        if (needsTextSearch) {
          params.push(query);
          conditions.push(`
            to_tsvector('english', 
              COALESCE(standardized_address, '') || ' ' || 
              COALESCE(unparsed_address, '') || ' ' || 
              COALESCE(city, '') || ' ' || 
              COALESCE(province, '') || ' ' || 
              COALESCE(postal_code, '') || ' ' ||
              COALESCE(property_type, '') || ' ' ||
              COALESCE(public_remarks, '')
            ) @@ plainto_tsquery('english', $${params.length})
          `);
        }
        
        // Location-based search
        if (needsSpatialSearch) {
          // Geocode the search location
          const { lat, lng } = await geocodeWithCache(location);
          
          if (lat && lng) {
            // Add these parameters for the spatial search
            params.push(lng);
            params.push(lat);
            params.push(parseFloat(radius) / 111.32); // Convert km to degrees (approx)
            
            conditions.push(`
              (latitude IS NOT NULL AND longitude IS NOT NULL) AND
              ST_DWithin(
                ST_SetSRID(ST_MakePoint(longitude, latitude), 4326),
                ST_SetSRID(ST_MakePoint($${params.length-2}, $${params.length-1}), 4326),
                $${params.length}
              )
            `);
          }
        }
        
        // Price range
        if (minPrice) {
          params.push(parseFloat(minPrice));
          conditions.push(`list_price >= $${params.length}`);
        }
        
        if (maxPrice) {
          params.push(parseFloat(maxPrice));
          conditions.push(`list_price <= $${params.length}`);
        }
        
        // Other filters
        if (bedrooms) {
          params.push(parseInt(bedrooms, 10));
          conditions.push(`bedrooms_total >= $${params.length}`);
        }
        
        if (bathrooms) {
          params.push(parseInt(bathrooms, 10));
          conditions.push(`bathrooms_total >= $${params.length}`);
        }
        
        if (propertyType) {
          params.push(propertyType);
          conditions.push(`property_type = $${params.length}`);
        }
        
        if (city) {
          params.push(city);
          conditions.push(`city = $${params.length}`);
        }
        
        if (province) {
          params.push(province);
          conditions.push(`province = $${params.length}`);
        }
        
        // Build the query with relevance ranking
        const selectClause = `
          SELECT *, 
          CASE WHEN $1 <> '' THEN 
            ts_rank(
              to_tsvector('english', 
                COALESCE(standardized_address, '') || ' ' || 
                COALESCE(unparsed_address, '') || ' ' || 
                COALESCE(city, '') || ' ' || 
                COALESCE(property_type, '')
              ), 
              plainto_tsquery('english', $1)
            )
          ELSE 0 END as relevance
        `;
        
        let queryStr = `${selectClause} FROM listings`;
        
        if (conditions.length > 0) {
          queryStr += ' WHERE ' + conditions.join(' AND ');
        }
        
        // Add ordering
        if (needsTextSearch) {
          queryStr += ` ORDER BY relevance DESC, modification_timestamp DESC`;
        } else {
          queryStr += ` ORDER BY modification_timestamp DESC`;
        }
        
        // Add pagination
        params.push(parseInt(limit, 10));
        queryStr += ` LIMIT $${params.length}`;
        
        params.push(parseInt(offset, 10));
        queryStr += ` OFFSET $${params.length}`;
        
        // Execute query
        const result = await client.query(queryStr, params);
        
        // Count total results
        let countQuery = 'SELECT COUNT(*) FROM listings';
        
        if (conditions.length > 0) {
          countQuery += ' WHERE ' + conditions.join(' AND ');
        }
        
        const countResult = await client.query(countQuery, params.slice(0, -2));
        const totalCount = parseInt(countResult.rows[0].count, 10);
        
        // Format response
        return res.json({
          total: totalCount,
          limit: parseInt(limit, 10),
          offset: parseInt(offset, 10),
          properties: result.rows
        });
      } finally {
        client.release();
      }
    } else {
      // Use Drizzle ORM for simpler queries
      // Build conditions array for cleaner filtering
      const conditions = [];
      
      if (city) {
        conditions.push(eq(listings.city, city));
      }
      
      if (propertyType) {
        conditions.push(eq(listings.propertyType, propertyType));
      }
      
      if (minPrice) {
        conditions.push(gte(listings.listPrice, parseFloat(minPrice)));
      }
      
      if (maxPrice) {
        conditions.push(lte(listings.listPrice, parseFloat(maxPrice)));
      }
      
      if (bedrooms) {
        conditions.push(gte(listings.bedroomsTotal, parseInt(bedrooms, 10)));
      }
      
      if (province) {
        conditions.push(eq(listings.province, province));
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
        properties: result
      });
    }
  } catch (error) {
    logger.error('Search error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Autocomplete suggestions for address search
 */
router.get('/suggest', async (req, res) => {
  try {
    const { query } = req.query;
    
    if (!query || query.length < 2) {
      return res.json({ suggestions: [] });
    }
    
    const client = await pool.connect();
    
    try {
      // Get address suggestions
      const addressResult = await client.query(`
        SELECT 
          DISTINCT ON (city, postal_code, street_name)
          city, province, postal_code, street_name, property_type,
          COUNT(*) OVER (PARTITION BY city, province) as city_count
        FROM listings
        WHERE 
          standardized_address IS NOT NULL AND
          (
            city ILIKE $1 OR
            street_name ILIKE $1 OR
            postal_code ILIKE $1 OR
            standardized_address ILIKE $1
          )
        ORDER BY city, postal_code, street_name, city_count DESC
        LIMIT 10
      `, [`%${query}%`]);
      
      // Format suggestions
      const suggestions = addressResult.rows.map(row => {
        if (row.street_name && row.city) {
          return {
            type: 'address',
            text: `${row.street_name}, ${row.city}, ${row.province}`,
            data: row
          };
        } else if (row.city) {
          return {
            type: 'city',
            text: `${row.city}, ${row.province}`,
            data: row
          };
        } else {
          return {
            type: 'postal',
            text: row.postal_code,
            data: row
          };
        }
      });
      
      return res.json({ suggestions });
    } finally {
      client.release();
    }
  } catch (error) {
    logger.error('Suggestion error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Get property filters (for building search UI)
 */
router.get('/filters', async (req, res) => {
  try {
    const client = await pool.connect();
    
    try {
      // Get distinct property types
      const propertyTypesResult = await client.query(`
        SELECT DISTINCT property_type
        FROM listings
        WHERE property_type IS NOT NULL
        ORDER BY property_type
      `);
      
      // Get distinct cities
      const citiesResult = await client.query(`
        SELECT DISTINCT city, province, COUNT(*) as count
        FROM listings
        WHERE city IS NOT NULL
        GROUP BY city, province
        ORDER BY count DESC, city
        LIMIT 50
      `);
      
      // Get price ranges
      const priceRangeResult = await client.query(`
        SELECT 
          MIN(list_price) as min_price,
          MAX(list_price) as max_price,
          percentile_cont(0.25) WITHIN GROUP (ORDER BY list_price) as lower_quartile,
          percentile_cont(0.75) WITHIN GROUP (ORDER BY list_price) as upper_quartile
        FROM listings
        WHERE list_price > 0
      `);
      
      return res.json({
        property_types: propertyTypesResult.rows.map(row => row.property_type),
        cities: citiesResult.rows.map(row => ({ 
          city: row.city, 
          province: row.province,
          count: parseInt(row.count, 10)
        })),
        price_range: priceRangeResult.rows[0]
      });
    } finally {
      client.release();
    }
  } catch (error) {
    logger.error('Filters error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router; 