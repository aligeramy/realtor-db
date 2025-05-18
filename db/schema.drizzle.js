import { pgTable, text, integer, doublePrecision, numeric, timestamp, jsonb, boolean, primaryKey } from 'drizzle-orm/pg-core';

// Listings table schema
export const listings = pgTable('listings', {
  // Primary identifier
  id: text('id').primaryKey(),
  
  // Location data
  unparsedAddress: text('unparsed_address'),
  streetNumber: text('street_number'),
  streetName: text('street_name'),
  streetSuffix: text('street_suffix'),
  unitNumber: text('unit_number'),
  city: text('city'),
  province: text('province'),
  postalCode: text('postal_code'),
  country: text('country'),
  countyOrParish: text('county_or_parish'),
  
  // Geolocation
  latitude: doublePrecision('latitude'),
  longitude: doublePrecision('longitude'),
  geoSource: text('geo_source'),
  
  // Property details
  propertyType: text('property_type'),
  propertySubType: text('property_sub_type'),
  transactionType: text('transaction_type'),
  contractStatus: text('contract_status'),
  buildingName: text('building_name'),
  yearBuilt: integer('year_built'),
  
  // Dimensions and areas
  lotSizeArea: doublePrecision('lot_size_area'),
  lotSizeUnits: text('lot_size_units'),
  livingArea: doublePrecision('living_area'),
  aboveGradeFinishedArea: doublePrecision('above_grade_finished_area'),
  belowGradeFinishedArea: doublePrecision('below_grade_finished_area'),
  lotWidth: doublePrecision('lot_width'),
  lotDepth: doublePrecision('lot_depth'),
  lotFrontage: text('lot_frontage'),
  
  // Room counts
  bedroomsTotal: integer('bedrooms_total'),
  bedroomsAboveGrade: integer('bedrooms_above_grade'),
  bedroomsBelowGrade: integer('bedrooms_below_grade'),
  bathroomsTotal: integer('bathrooms_total'),
  kitchensTotal: integer('kitchens_total'),
  roomsTotal: integer('rooms_total'),
  
  // Features (arrays for easier querying)
  interiorFeatures: text('interior_features').array(),
  exteriorFeatures: text('exterior_features').array(),
  parkingFeatures: text('parking_features').array(),
  waterFeatures: text('water_features').array(),
  
  // Commercial-specific
  zoning: text('zoning'),
  businessType: text('business_type').array(),
  
  // Financial data
  listPrice: numeric('list_price'),
  originalListPrice: numeric('original_list_price'),
  closePrice: numeric('close_price'),
  associationFee: numeric('association_fee'),
  taxAnnualAmount: numeric('tax_annual_amount'),
  taxYear: integer('tax_year'),
  
  // Images and media
  mediaKeys: text('media_keys').array(),
  preferredMediaKey: text('preferred_media_key'),
  virtualTourUrl: text('virtual_tour_url'),
  
  // Textual information
  publicRemarks: text('public_remarks'),
  privateRemarks: text('private_remarks'),
  taxLegalDescription: text('tax_legal_description'),
  directions: text('directions'),
  
  // Important dates
  listDate: timestamp('list_date'),
  expirationDate: timestamp('expiration_date'),
  closeDate: timestamp('close_date'),
  
  // System fields
  standardStatus: text('standard_status'),
  modificationTimestamp: timestamp('modification_timestamp'),
  originatingSystemId: text('originating_system_id'),
  originatingSystemName: text('originating_system_name'),
  
  // Track record updates
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
  
  // Store the complete raw data for future field expansion
  raw: jsonb('raw')
});

// Listing media table schema
export const listingMedia = pgTable('listing_media', {
  // Primary key
  mediaKey: text('media_key').primaryKey(),
  
  // Foreign key to listings
  listingId: text('listing_id').references(() => listings.id, { onDelete: 'cascade' }),
  
  // Media properties
  mediaType: text('media_type'),
  mediaCategory: text('media_category'),
  mediaUrl: text('media_url'),
  mediaStatus: text('media_status'),
  imageHeight: integer('image_height'),
  imageWidth: integer('image_width'),
  isPreferred: boolean('is_preferred').default(false),
  displayOrder: integer('display_order'),
  shortDescription: text('short_description'),
  
  // Track record updates
  modificationTimestamp: timestamp('modification_timestamp'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow()
});

// Replication state table schema
export const replicationState = pgTable('replication_state', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  resourceName: text('resource_name').notNull(),
  lastTimestamp: text('last_timestamp').notNull(),
  lastKey: text('last_key').notNull(),
  recordsProcessed: integer('records_processed').default(0),
  lastRunAt: timestamp('last_run_at').defaultNow()
}); 