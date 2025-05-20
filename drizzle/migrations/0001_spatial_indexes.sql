-- Migration to add spatial indexes for property search capabilities
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS postgis_topology;

-- Spatial index for geographic location-based queries
CREATE INDEX IF NOT EXISTS idx_listings_location 
ON "listings" 
USING GIST (ST_SetSRID(ST_MakePoint("longitude", "latitude"), 4326));

-- Full text search index for property search
CREATE INDEX IF NOT EXISTS idx_listings_text_search 
ON "listings" 
USING GIN (to_tsvector('english', 
  COALESCE("standardized_address", '') || ' ' || 
  COALESCE("unparsed_address", '') || ' ' || 
  COALESCE("city", '') || ' ' || 
  COALESCE("province", '') || ' ' || 
  COALESCE("postal_code", '') || ' ' ||
  COALESCE("property_type", '') || ' ' ||
  COALESCE("public_remarks", '')
));

-- Index on modification_timestamp for faster replication queries
CREATE INDEX IF NOT EXISTS idx_listings_modification_timestamp
ON "listings" ("modification_timestamp");

-- Create meta file for drizzle to track this migration 