-- Drop existing tables if they exist (in the correct order to handle dependencies)
DROP TABLE IF EXISTS listing_media CASCADE;
DROP TABLE IF EXISTS listings CASCADE;
DROP TABLE IF EXISTS replication_state CASCADE;

-- Create listings table with improved structure
CREATE TABLE IF NOT EXISTS listings (
  -- Primary identifier
  id TEXT PRIMARY KEY,
  
  -- Location data
  unparsed_address TEXT NULL,
  street_number TEXT NULL,
  street_name TEXT NULL,
  street_suffix TEXT NULL,
  unit_number TEXT NULL,
  city TEXT NULL,
  province TEXT NULL,
  postal_code TEXT NULL,
  country TEXT NULL,
  county_or_parish TEXT NULL,
  
  -- Geolocation 
  latitude DOUBLE PRECISION NULL,
  longitude DOUBLE PRECISION NULL,
  geo_source TEXT NULL,
  
  -- Property details
  property_type TEXT NULL,
  property_sub_type TEXT NULL,
  transaction_type TEXT NULL,
  contract_status TEXT NULL,
  building_name TEXT NULL,
  year_built INTEGER NULL,
  
  -- Dimensions and areas
  lot_size_area DOUBLE PRECISION NULL,
  lot_size_units TEXT NULL,
  living_area DOUBLE PRECISION NULL,
  above_grade_finished_area DOUBLE PRECISION NULL,
  below_grade_finished_area DOUBLE PRECISION NULL,
  lot_width DOUBLE PRECISION NULL,
  lot_depth DOUBLE PRECISION NULL,
  lot_frontage TEXT NULL,
  
  -- Room counts
  bedrooms_total INTEGER NULL,
  bedrooms_above_grade INTEGER NULL,
  bedrooms_below_grade INTEGER NULL,
  bathrooms_total INTEGER NULL,
  kitchens_total INTEGER NULL,
  rooms_total INTEGER NULL,
  
  -- Features (arrays for easier querying)
  interior_features TEXT[] NULL,
  exterior_features TEXT[] NULL,
  parking_features TEXT[] NULL,
  water_features TEXT[] NULL,
  
  -- Commercial-specific
  zoning TEXT NULL,
  business_type TEXT[] NULL,
  
  -- Financial data
  list_price NUMERIC NULL,
  original_list_price NUMERIC NULL,
  close_price NUMERIC NULL,
  association_fee NUMERIC NULL,
  tax_annual_amount NUMERIC NULL,
  tax_year INTEGER NULL,
  
  -- Images and media 
  media_keys TEXT[] NULL,
  preferred_media_key TEXT NULL,
  virtual_tour_url TEXT NULL,
  
  -- Textual information
  public_remarks TEXT NULL,
  private_remarks TEXT NULL,
  tax_legal_description TEXT NULL,
  directions TEXT NULL,
  
  -- Important dates
  list_date DATE NULL,
  expiration_date DATE NULL,
  close_date DATE NULL,
  
  -- System fields
  standard_status TEXT NULL,
  modification_timestamp TIMESTAMP WITHOUT TIME ZONE NULL,
  originating_system_id TEXT NULL,
  originating_system_name TEXT NULL,
  
  -- Track record updates
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  
  -- Store the complete raw data for future field expansion
  raw JSONB NULL
);

-- Create listing media table to efficiently store and query media
CREATE TABLE IF NOT EXISTS listing_media (
  -- Primary key
  media_key TEXT PRIMARY KEY,
  
  -- Foreign key to listings
  listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  
  -- Media properties
  media_type TEXT NULL,
  media_category TEXT NULL,
  media_url TEXT NULL,
  media_status TEXT NULL,
  image_height INTEGER NULL,
  image_width INTEGER NULL, 
  is_preferred BOOLEAN DEFAULT FALSE,
  display_order INTEGER NULL,
  short_description TEXT NULL,
  
  -- Track record updates
  modification_timestamp TIMESTAMP WITHOUT TIME ZONE NULL,
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);

-- Create replication state tracking table
CREATE TABLE IF NOT EXISTS replication_state (
  id SERIAL PRIMARY KEY,
  resource_name TEXT NOT NULL,
  last_timestamp TEXT NOT NULL,
  last_key TEXT NOT NULL,
  records_processed INTEGER DEFAULT 0,
  last_run_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);

-- Create efficient indices for common query patterns
-- Geographic queries
CREATE INDEX idx_listings_geo ON listings USING gist (point(longitude, latitude));
CREATE INDEX idx_listings_city ON listings(city);
CREATE INDEX idx_listings_province ON listings(province);
CREATE INDEX idx_listings_postal_code ON listings(postal_code);

-- Property characteristic queries
CREATE INDEX idx_listings_property_type ON listings(property_type);
CREATE INDEX idx_listings_property_sub_type ON listings(property_sub_type);
CREATE INDEX idx_listings_bedrooms_total ON listings(bedrooms_total);
CREATE INDEX idx_listings_bathrooms_total ON listings(bathrooms_total);

-- Price range queries
CREATE INDEX idx_listings_list_price ON listings(list_price);
CREATE INDEX idx_listings_status_price ON listings(standard_status, list_price);

-- Status and update time queries
CREATE INDEX idx_listings_status ON listings(standard_status);
CREATE INDEX idx_listings_modification_timestamp ON listings(modification_timestamp);

-- Full-text search on description
CREATE INDEX idx_listings_description_fts ON listings USING gin (to_tsvector('english', public_remarks));

-- Media queries
CREATE INDEX idx_listing_media_listing_id ON listing_media(listing_id);
CREATE INDEX idx_listing_media_preferred ON listing_media(listing_id, is_preferred);

-- Insert initial replication state
INSERT INTO replication_state (resource_name, last_timestamp, last_key)
VALUES ('Property', '1970-01-01T00:00:00Z', '0')
ON CONFLICT (id) DO NOTHING;

-- Create trigger to automatically update timestamps
CREATE OR REPLACE FUNCTION update_modified_column()
RETURNS TRIGGER AS $$
BEGIN
   NEW.updated_at = NOW(); 
   RETURN NEW;
END;
$$ LANGUAGE 'plpgsql';

-- Apply triggers to both tables
CREATE TRIGGER update_listings_timestamp
BEFORE UPDATE ON listings
FOR EACH ROW EXECUTE PROCEDURE update_modified_column();

CREATE TRIGGER update_listing_media_timestamp
BEFORE UPDATE ON listing_media
FOR EACH ROW EXECUTE PROCEDURE update_modified_column(); 