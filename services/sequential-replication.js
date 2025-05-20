import { getPropertyBatch, getPropertyMedia, getMediaBatch } from './ampre-api.js';
import { getReplicationState, updateReplicationState, upsertListing, upsertMedia, isListingInDatabase } from '../db/index.js';
import { logger } from '../utils/logger.js';

// Extract and transform property field values (reused from replication.js)
const extractFieldValue = (property, field, defaultValue = null) => {
  return property[field] !== undefined ? property[field] : defaultValue;
};

// Convert array field from API (reused from replication.js)
const extractArrayField = (property, field) => {
  const value = property[field];
  if (!value || !Array.isArray(value) || value.length === 0) return null;
  return value;
};

// Map AMPRE property fields to our enhanced database schema (reused from replication.js)
const mapProperty = async (property) => {
  // Create base listing data structure
  const listingData = {
    // Identifiers
    id: property.ListingKey,
    
    // Location data
    unparsed_address: extractFieldValue(property, 'UnparsedAddress'),
    street_number: extractFieldValue(property, 'StreetNumber'),
    street_name: extractFieldValue(property, 'StreetName'),
    street_suffix: extractFieldValue(property, 'StreetSuffix'),
    unit_number: extractFieldValue(property, 'UnitNumber'),
    city: extractFieldValue(property, 'City'),
    province: extractFieldValue(property, 'StateOrProvince'),
    postal_code: extractFieldValue(property, 'PostalCode'),
    country: extractFieldValue(property, 'Country'),
    county_or_parish: extractFieldValue(property, 'CountyOrParish'),
    
    // Geolocation
    latitude: extractFieldValue(property, 'Latitude') ? parseFloat(property.Latitude) : null,
    longitude: extractFieldValue(property, 'Longitude') ? parseFloat(property.Longitude) : null,
    geo_source: extractFieldValue(property, 'GeoSource'),
    
    // Property details
    property_type: extractFieldValue(property, 'PropertyType'),
    property_sub_type: extractFieldValue(property, 'PropertySubType'),
    transaction_type: extractFieldValue(property, 'TransactionType'),
    contract_status: extractFieldValue(property, 'ContractStatus'),
    building_name: extractFieldValue(property, 'BuildingName'),
    year_built: extractFieldValue(property, 'YearBuilt') ? parseInt(property.YearBuilt, 10) : null,
    
    // Dimensions and areas
    lot_size_area: extractFieldValue(property, 'LotSizeArea') ? parseFloat(property.LotSizeArea) : null,
    lot_size_units: extractFieldValue(property, 'LotSizeUnits'),
    living_area: extractFieldValue(property, 'BuildingAreaTotal') ? parseFloat(property.BuildingAreaTotal) : null,
    above_grade_finished_area: extractFieldValue(property, 'AboveGradeFinishedArea') ? parseFloat(property.AboveGradeFinishedArea) : null,
    below_grade_finished_area: extractFieldValue(property, 'BelowGradeFinishedArea') ? parseFloat(property.BelowGradeFinishedArea) : null,
    lot_width: extractFieldValue(property, 'LotWidth') ? parseFloat(property.LotWidth) : null,
    lot_depth: extractFieldValue(property, 'LotDepth') ? parseFloat(property.LotDepth) : null,
    lot_frontage: extractFieldValue(property, 'FrontageLength'),
    
    // Room counts
    bedrooms_total: extractFieldValue(property, 'BedroomsTotal') ? parseInt(property.BedroomsTotal, 10) : null,
    bedrooms_above_grade: extractFieldValue(property, 'BedroomsAboveGrade') ? parseInt(property.BedroomsAboveGrade, 10) : null,
    bedrooms_below_grade: extractFieldValue(property, 'BedroomsBelowGrade') ? parseInt(property.BedroomsBelowGrade, 10) : null,
    bathrooms_total: extractFieldValue(property, 'BathroomsTotalInteger') ? parseInt(property.BathroomsTotalInteger, 10) : null,
    kitchens_total: extractFieldValue(property, 'KitchensTotal') ? parseInt(property.KitchensTotal, 10) : null,
    rooms_total: extractFieldValue(property, 'RoomsTotal') ? parseInt(property.RoomsTotal, 10) : null,
    
    // Features (arrays)
    interior_features: extractArrayField(property, 'InteriorFeatures'),
    exterior_features: extractArrayField(property, 'ExteriorFeatures'),
    parking_features: extractArrayField(property, 'ParkingFeatures'),
    water_features: extractArrayField(property, 'WaterfrontFeatures'),
    
    // Commercial-specific
    zoning: extractFieldValue(property, 'Zoning'),
    business_type: extractArrayField(property, 'BusinessType'),
    
    // Financial data
    list_price: extractFieldValue(property, 'ListPrice') ? parseFloat(property.ListPrice) : null,
    original_list_price: extractFieldValue(property, 'OriginalListPrice') ? parseFloat(property.OriginalListPrice) : null,
    close_price: extractFieldValue(property, 'ClosePrice') ? parseFloat(property.ClosePrice) : null,
    association_fee: extractFieldValue(property, 'AssociationFee') ? parseFloat(property.AssociationFee) : null,
    tax_annual_amount: extractFieldValue(property, 'TaxAnnualAmount') ? parseFloat(property.TaxAnnualAmount) : null,
    tax_year: extractFieldValue(property, 'TaxYear') ? parseInt(property.TaxYear, 10) : null,
    
    // Media (initial empty array, to be populated separately in the media phase)
    media_keys: [],
    preferred_media_key: null,
    virtual_tour_url: extractFieldValue(property, 'VirtualTourURLUnbranded') || extractFieldValue(property, 'VirtualTourURLBranded'),
    
    // Textual information
    public_remarks: extractFieldValue(property, 'PublicRemarks'),
    private_remarks: extractFieldValue(property, 'PrivateRemarks'),
    tax_legal_description: extractFieldValue(property, 'TaxLegalDescription'),
    directions: extractFieldValue(property, 'Directions'),
    
    // Important dates
    list_date: extractFieldValue(property, 'ListingContractDate'),
    expiration_date: extractFieldValue(property, 'ExpirationDate'),
    close_date: extractFieldValue(property, 'CloseDate'),
    
    // System fields
    standard_status: extractFieldValue(property, 'StandardStatus'),
    modification_timestamp: new Date(property.ModificationTimestamp),
    originating_system_id: extractFieldValue(property, 'OriginatingSystemID'),
    originating_system_name: extractFieldValue(property, 'OriginatingSystemName'),
    
    // Complete raw data
    raw: property
  };

  return listingData;
};

// Process a single media item
const processMediaItem = async (mediaItem, listingId) => {
  try {
    // Check if listing exists in database
    const listingExists = await isListingInDatabase(listingId);
    
    if (!listingExists) {
      logger.warn(`Cannot store media for listing ${listingId} as the listing does not exist in database`);
      return false;
    }
    
    const mediaData = {
      media_key: mediaItem.MediaKey,
      listing_id: listingId,
      media_type: mediaItem.MediaType,
      media_category: mediaItem.MediaCategory,
      media_url: mediaItem.MediaURL,
      media_status: mediaItem.MediaStatus,
      image_height: mediaItem.ImageHeight ? parseInt(mediaItem.ImageHeight, 10) : null,
      image_width: mediaItem.ImageWidth ? parseInt(mediaItem.ImageWidth, 10) : null,
      is_preferred: mediaItem.PreferredPhotoYN === true,
      display_order: mediaItem.Order ? parseInt(mediaItem.Order, 10) : null,
      short_description: mediaItem.ShortDescription,
      modification_timestamp: new Date(mediaItem.ModificationTimestamp)
    };
    
    await upsertMedia(mediaData);
    return true;
  } catch (error) {
    // Special handling for timeout errors 
    if (error.code === 'ECONNABORTED' || (error.message && error.message.includes('timeout'))) {
      logger.warn(`Timeout processing media ${mediaItem.MediaKey} for listing ${listingId}, skipping`);
    } else {
      logger.error(`Failed to process media ${mediaItem.MediaKey} for listing ${listingId}:`, 
                  error.message || error);
    }
    return false;
  }
};

// Phase 1: Replicate property listings
export const replicateProperties = async () => {
  console.log("Starting Phase 1: Property Replication");
  try {
    const startTime = Date.now();
    logger.info('Starting property replication (Phase 1)');
    
    // Get the last replication state for properties
    const { lastTimestamp, lastKey } = await getReplicationState('Property');
    
    // Set batch size and counters - increase batch size to take advantage of AMPRE limits
    const batchSize = parseInt(process.env.REPLICATION_BATCH_SIZE, 10) || 1000; // Increased from 100 to 1000
    const maxRecords = parseInt(process.env.REPLICATION_MAX_RECORDS, 10) || 0;
    
    let lastProcessedTimestamp = lastTimestamp;
    let lastProcessedKey = lastKey;
    let totalProcessed = 0;
    let batchesProcessed = 0;
    
    console.log(`Starting property replication from timestamp ${lastTimestamp} and key ${lastKey}`);
    console.log(`Using optimized batch size: ${batchSize}`);
    logger.info(`Starting property replication from timestamp ${lastTimestamp} and key ${lastKey}`);
    logger.info(`Using optimized batch size: ${batchSize}`);
    
    // Main replication loop
    while (true) {
      batchesProcessed++;
      
      // Check if we've reached the maximum records limit
      if (maxRecords > 0 && totalProcessed >= maxRecords) {
        logger.info(`Reached maximum property record limit of ${maxRecords}`);
        break;
      }
      
      // Calculate batch size
      const currentBatchSize = maxRecords > 0 ? 
        Math.min(batchSize, maxRecords - totalProcessed) : batchSize;
      
      console.log(`Fetching property batch ${batchesProcessed} with timestamp ${lastProcessedTimestamp} and key ${lastProcessedKey}`);
      
      // Get a batch of properties
      const { items, count } = await getPropertyBatch(
        lastProcessedTimestamp, 
        lastProcessedKey,
        currentBatchSize
      );
      
      console.log(`Received ${count} property items in batch ${batchesProcessed}`);
      
      if (count === 0) {
        logger.info('No more properties to replicate');
        break;
      }
      
      // Process properties with improved concurrency
      let batchProcessed = 0;
      let newTimestamp = null;
      let newKey = null;
      
      // Process in parallel but limit concurrency to avoid overwhelming the database
      // Using a larger chunk size for better throughput
      const chunkSize = 50; // Increased from typical 10
      const chunks = [];
      
      // Split the items into chunks for parallel processing
      for (let i = 0; i < items.length; i += chunkSize) {
        chunks.push(items.slice(i, i + chunkSize));
      }
      
      // Process chunks in sequence, but items within chunks in parallel
      for (const chunk of chunks) {
        const chunkResults = await Promise.all(
          chunk.map(async (property) => {
            try {
              const mappedProperty = await mapProperty(property);
              await upsertListing(mappedProperty);
              
              return {
                success: true,
                timestamp: property.ModificationTimestamp,
                key: property.ListingKey
              };
            } catch (error) {
              logger.error(`Failed to process property ${property.ListingKey}:`, error);
              return { success: false };
            }
          })
        );
        
        // Count successes and track last timestamp/key
        const successResults = chunkResults.filter(r => r.success);
        batchProcessed += successResults.length;
        
        if (successResults.length > 0) {
          // Get the last successful result
          const lastResult = successResults[successResults.length - 1];
          newTimestamp = lastResult.timestamp;
          newKey = lastResult.key;
        }
      }
      
      // Update checkpoint if we processed any properties
      if (batchProcessed > 0 && newTimestamp && newKey) {
        lastProcessedTimestamp = newTimestamp;
        lastProcessedKey = newKey;
        
        await updateReplicationState('Property', newTimestamp, newKey, batchProcessed);
        console.log(`Updated property replication state to timestamp ${newTimestamp} and key ${newKey}`);
      }
      
      totalProcessed += batchProcessed;
      
      // Log progress
      const elapsedSeconds = (Date.now() - startTime) / 1000;
      const recordsPerSecond = Math.round((totalProcessed / elapsedSeconds) * 100) / 100;
      logger.info(`Processed property batch ${batchesProcessed}: ${totalProcessed} properties (${recordsPerSecond} records/sec)`);
      
      // If we received fewer records than requested, we're done
      if (count < currentBatchSize) {
        logger.info('Received fewer property records than requested, assuming completion');
        break;
      }
    }
    
    // Calculate statistics
    const durationSeconds = (Date.now() - startTime) / 1000;
    const recordsPerSecond = Math.round((totalProcessed / durationSeconds) * 100) / 100;
    
    console.log(`Property replication completed in ${durationSeconds}s. Processed ${totalProcessed} properties at ${recordsPerSecond} records/sec.`);
    logger.info(`Property replication completed in ${durationSeconds}s. Processed ${totalProcessed} properties at ${recordsPerSecond} records/sec.`);
    
    return {
      processed: totalProcessed,
      duration: durationSeconds,
      rate: recordsPerSecond
    };
  } catch (error) {
    console.error('Property replication failed:', error);
    logger.error('Property replication failed:', error);
    throw error;
  }
};

// Phase 2: Replicate media for properties
export const replicateMedia = async () => {
  console.log("Starting Phase 2: Media Replication");
  try {
    const startTime = Date.now();
    logger.info('Starting media replication (Phase 2)');
    
    // Get all listing IDs from the database that need media
    // Using smaller batches to avoid media fetching errors
    let offset = 0;
    const limit = 100; // Reduced from 200 to 100 for better stability
    const maxProperties = 500; // Limit even further from 1000 to 500 per run to avoid timeout issues
    let totalMediaProcessed = 0;
    let listingsWithMedia = 0;
    let totalPropertiesProcessed = 0;
    
    // Prepare to handle rate limits
    const maxConcurrent = 10; // Reduced from 20 to 10 for better reliability
    
    while (totalPropertiesProcessed < maxProperties) {
      // Get a batch of property IDs
      const client = await global.pool.connect();
      const result = await client.query(`
        SELECT id FROM listings 
        ORDER BY id
        LIMIT $1 OFFSET $2
      `, [limit, offset]);
      client.release();
      
      if (result.rows.length === 0) {
        break; // No more properties
      }
      
      console.log(`Processing media for ${result.rows.length} properties (batch starting at offset ${offset})`);
      
      // Get all property IDs in this batch
      const propertyIds = result.rows.map(row => row.id);
      
      // Process properties in smaller batches for API efficiency
      const batchSize = 10; // Reduced from 20 to 10 for better stability
      let totalBatchMediaProcessed = 0;
      let totalBatchPropertiesWithMedia = 0;
      
      // Process in batches to avoid overwhelming the API
      for (let i = 0; i < propertyIds.length; i += batchSize) {
        const batchIds = propertyIds.slice(i, i + batchSize);
        
        try {
          // Get media for multiple properties in one batch
          const mediaByProperty = await getMediaBatch(batchIds);
          
          // Process all media items for all properties
          const processingPromises = [];
          const mediaKeysMap = {};
          const preferredKeysMap = {};
          
          // First, organize what needs to be processed
          for (const propertyId of batchIds) {
            const mediaItems = mediaByProperty[propertyId] || [];
            
            if (mediaItems.length > 0) {
              totalBatchPropertiesWithMedia++;
              
              // Track media keys and preferred media for this property
              mediaKeysMap[propertyId] = [];
              
              // Find preferred media
              const preferredItem = mediaItems.find(item => item.PreferredPhotoYN === true);
              preferredKeysMap[propertyId] = preferredItem 
                ? preferredItem.MediaKey 
                : (mediaItems.length > 0 ? mediaItems[0].MediaKey : null);
              
              // Queue up all media items for processing
              for (const mediaItem of mediaItems) {
                processingPromises.push(
                  processMediaItem(mediaItem, propertyId)
                    .then(success => {
                      if (success) {
                        mediaKeysMap[propertyId].push(mediaItem.MediaKey);
                        totalBatchMediaProcessed++;
                        return true;
                      }
                      return false;
                    })
                );
              }
            }
          }
          
          // Process all media items concurrently
          await Promise.all(processingPromises);
          
          // Now update all properties with their media keys
          const updatePromises = [];
          
          for (const propertyId in mediaKeysMap) {
            if (mediaKeysMap[propertyId].length > 0) {
              updatePromises.push(
                (async () => {
                  try {
                    const updateClient = await global.pool.connect();
                    await updateClient.query(`
                      UPDATE listings
                      SET media_keys = $1,
                          preferred_media_key = $2
                      WHERE id = $3
                    `, [
                      mediaKeysMap[propertyId], 
                      preferredKeysMap[propertyId] || mediaKeysMap[propertyId][0], 
                      propertyId
                    ]);
                    updateClient.release();
                    
                    console.log(`Updated property ${propertyId} with ${mediaKeysMap[propertyId].length} media keys`);
                  } catch (updateError) {
                    logger.error(`Failed to update media keys for property ${propertyId}:`, updateError);
                  }
                })()
              );
            }
          }
          
          await Promise.all(updatePromises);
          
        } catch (error) {
          logger.error(`Failed to process media batch for ${batchIds.length} properties:`, error);
        }
      }
      
      // Update overall stats
      totalMediaProcessed += totalBatchMediaProcessed;
      listingsWithMedia += totalBatchPropertiesWithMedia;
      
      // Update counters and log progress
      offset += result.rows.length;
      totalPropertiesProcessed += result.rows.length;
      
      console.log(`Processed media for ${totalPropertiesProcessed} properties so far, found ${totalMediaProcessed} media items for ${listingsWithMedia} listings`);
    }
    
    // Calculate statistics
    const durationSeconds = (Date.now() - startTime) / 1000;
    const recordsPerSecond = Math.round((totalMediaProcessed / durationSeconds) * 100) / 100;
    
    console.log(`Media replication completed in ${durationSeconds}s. Processed ${totalMediaProcessed} media items for ${listingsWithMedia} listings at ${recordsPerSecond} media/sec.`);
    logger.info(`Media replication completed in ${durationSeconds}s. Processed ${totalMediaProcessed} media items for ${listingsWithMedia} listings at ${recordsPerSecond} media/sec.`);
    
    return {
      mediaProcessed: totalMediaProcessed,
      listingsWithMedia,
      duration: durationSeconds,
      rate: recordsPerSecond
    };
  } catch (error) {
    console.error('Media replication failed:', error);
    logger.error('Media replication failed:', error);
    throw error;
  }
};

// Run full two-phase replication
export const replicateAll = async () => {
  try {
    // Phase 1: Replicate properties
    const propertyResult = await replicateProperties();
    
    // Phase 2: Replicate media (only if properties were replicated successfully)
    const mediaResult = await replicateMedia();
    
    return {
      properties: propertyResult,
      media: mediaResult
    };
  } catch (error) {
    logger.error('Full replication failed:', error);
    throw error;
  }
}; 