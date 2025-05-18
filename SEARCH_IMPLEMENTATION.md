# Intuitive Search Implementation for Property Listings Database

## Current Data Analysis

Your database currently has:
- 99,580 property listings from AMPRE API
- No duplicates (good data hygiene)
- Various address fields but likely inconsistent formatting

## Best Approaches for Intuitive Search

### 1. Address Standardization + Geocoding

**Recommendation**: Process addresses in batch now rather than at search time.

```sql
-- Sample of your address data structure
SELECT 
  id, 
  unparsed_address, 
  street_number, 
  street_name, 
  city, 
  province, 
  postal_code,
  latitude,
  longitude
FROM listings
LIMIT 5;
```

**Implementation plan**:

1. Create a batch processing script to:
   - Standardize addresses using a combination of regex patterns and lookup tables
   - Geocode properties missing lat/long using Google's Geocoding API

```javascript
// Pseudocode for batch processing
async function standardizeAddresses() {
  // Query properties without standardized addresses
  const properties = await db.select()
    .from(listings)
    .where(eq(listings.standardizedAddress, null))
    .limit(100);
  
  for (const property of properties) {
    // Create standardized address
    const standardAddress = standardizeFormat(property);
    
    // Geocode if needed
    if (!property.latitude || !property.longitude) {
      const { lat, lng } = await geocodeAddress(standardAddress);
      
      // Update property
      await db.update(listings)
        .set({ 
          standardizedAddress: standardAddress,
          latitude: lat, 
          longitude: lng 
        })
        .where(eq(listings.id, property.id));
    } else {
      // Just update standardized address
      await db.update(listings)
        .set({ standardizedAddress: standardAddress })
        .where(eq(listings.id, property.id));
    }
  }
}
```

### 2. Full-Text Search + Proper Indexing

PostgreSQL supports powerful full-text search capabilities:

```sql
-- Create a GIN index on the address fields combined
CREATE INDEX idx_listings_address_tsvector ON listings 
USING GIN (to_tsvector('english', 
  COALESCE(standardized_address, '') || ' ' || 
  COALESCE(unparsed_address, '') || ' ' || 
  COALESCE(city, '') || ' ' || 
  COALESCE(province, '') || ' ' || 
  COALESCE(postal_code, '')
));

-- Create GIN index on property features
CREATE INDEX idx_listings_features_tsvector ON listings 
USING GIN (to_tsvector('english', 
  COALESCE(property_type, '') || ' ' || 
  COALESCE(public_remarks, '')
));

-- Create spatial index for geo queries
CREATE INDEX idx_listings_location ON listings 
USING GIST (ST_SetSRID(ST_MakePoint(longitude, latitude), 4326));
```

### 3. Implementing the Search API

Add this to your API routes:

```javascript
router.get('/search', async (req, res) => {
  try {
    const { 
      query,            // Text search
      location,         // Location search (address or postal code)
      radius,           // Search radius in km
      minPrice, 
      maxPrice,
      bedrooms,
      bathrooms,
      propertyType,
      limit = 20,
      offset = 0
    } = req.query;
    
    // Build conditions
    const conditions = [];
    const params = [];
    
    // Text search condition
    if (query) {
      conditions.push(`
        to_tsvector('english', 
          COALESCE(standardized_address, '') || ' ' || 
          COALESCE(unparsed_address, '') || ' ' || 
          COALESCE(city, '') || ' ' || 
          COALESCE(property_type, '') || ' ' ||
          COALESCE(public_remarks, '')
        ) @@ plainto_tsquery('english', $${params.push(query)})
      `);
    }
    
    // Location-based search
    if (location && radius) {
      // Geocode the search location
      const { lat, lng } = await geocodeAddress(location);
      if (lat && lng) {
        conditions.push(`
          ST_DWithin(
            ST_SetSRID(ST_MakePoint(longitude, latitude), 4326),
            ST_SetSRID(ST_MakePoint($${params.push(lng)}, $${params.push(lat)}), 4326),
            $${params.push(radius / 111.32)} // Convert km to degrees
          )
        `);
      }
    }
    
    // Price range
    if (minPrice) {
      conditions.push(`list_price >= $${params.push(parseFloat(minPrice))}`);
    }
    if (maxPrice) {
      conditions.push(`list_price <= $${params.push(parseFloat(maxPrice))}`);
    }
    
    // Other filters
    if (bedrooms) {
      conditions.push(`bedrooms_total >= $${params.push(parseInt(bedrooms, 10))}`);
    }
    if (bathrooms) {
      conditions.push(`bathrooms_total >= $${params.push(parseInt(bathrooms, 10))}`);
    }
    if (propertyType) {
      conditions.push(`property_type = $${params.push(propertyType)}`);
    }
    
    // Build the complete query
    let query = `
      SELECT *, 
      CASE WHEN $1 <> '' THEN 
        ts_rank(to_tsvector('english', COALESCE(standardized_address, '') || ' ' || COALESCE(unparsed_address, '')), plainto_tsquery('english', $1))
      ELSE 0 END as relevance
      FROM listings
    `;
    
    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }
    
    // Add ordering
    query += ` ORDER BY relevance DESC, modification_timestamp DESC LIMIT $${params.push(parseInt(limit, 10))} OFFSET $${params.push(parseInt(offset, 10))}`;
    
    // Execute query
    const client = await pool.connect();
    const result = await client.query(query, params);
    client.release();
    
    // Format response
    return res.json({
      total: result.rowCount,
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10),
      properties: result.rows
    });
  } catch (error) {
    logger.error('Search error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});
```

### 4. Autocomplete Suggestions

Create an additional endpoint for search suggestions:

```javascript
router.get('/suggest', async (req, res) => {
  try {
    const { query } = req.query;
    
    if (!query || query.length < 2) {
      return res.json({ suggestions: [] });
    }
    
    // Get address suggestions
    const addressResult = await pool.query(`
      SELECT 
        DISTINCT ON (city, postal_code, street_name)
        city, province, postal_code, street_name, property_type
      FROM listings
      WHERE 
        to_tsvector('english', 
          COALESCE(city, '') || ' ' || 
          COALESCE(street_name, '') || ' ' || 
          COALESCE(postal_code, '')
        ) @@ plainto_tsquery('english', $1)
      LIMIT 10
    `, [query]);
    
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
  } catch (error) {
    logger.error('Suggestion error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});
```

## Batch Processing vs. Real-time

For your use case, I recommend:

1. **Batch process addresses now**:
   - Run standardization and geocoding in batches during off-peak hours
   - Create a dedicated script to process 100-500 properties at a time
   - Store standardized formats in a new column

2. **Only geocode at search time when necessary**:
   - If user enters a non-standardized address, geocode just that input
   - Don't geocode your entire database in real-time

## Implementation Steps

1. **Add schema changes**:
   ```sql
   ALTER TABLE listings ADD COLUMN standardized_address TEXT;
   CREATE INDEX idx_listings_standardized_address ON listings(standardized_address);
   ```

2. **Create batch processing script**:
   ```javascript
   // scripts/standardize-addresses.js
   import { db, pool } from '../db/index.js';
   import { geocodeAddress, standardizeAddress } from '../utils/geocoding.js';
   
   async function processAddressBatch(batchSize = 100) {
     // Processing logic here
   }
   
   // Run with PM2 on a schedule
   processAddressBatch();
   ```

3. **Add search endpoints to API routes**

4. **Set up monitoring for batch processing**

## Address Standardization Function

Here's a more detailed implementation of the address standardization function:

```javascript
// utils/geocoding.js
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

/**
 * Standardize an address format using property fields
 */
export function standardizeAddress(property) {
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
  const postalComponent = postal_code || '';
  
  // Combine components to create standardized address
  const addressParts = [
    unitComponent,
    streetComponent,
    cityComponent,
    provinceComponent,
    postalComponent
  ].filter(Boolean);
  
  return addressParts.join(', ');
}

/**
 * Geocode an address using Google Maps API
 */
export async function geocodeAddress(address) {
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
    
    return { lat: null, lng: null };
  } catch (error) {
    console.error('Geocoding error:', error);
    return { lat: null, lng: null };
  }
}
```

## Performance Considerations

1. **Rate Limiting**: Google's Geocoding API has usage limits. Implement a queue system for batch processing with rate limiting.

2. **Caching**: Cache geocoding results to avoid redundant API calls.

3. **Progressive Enhancement**: Start with basic address standardization for all records, then gradually enhance with geocoding.

4. **Monitoring**: Track geocoding success rates and processing times to optimize batch sizes.

This comprehensive approach balances preprocessing with real-time search capabilities to create an intuitive search experience that performs well at scale. 