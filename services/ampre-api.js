import axios from 'axios';
import dotenv from 'dotenv';
import { logger } from '../utils/logger.js';
import { isListingInDatabase, upsertMedia, getReplicationState } from '../db/index.js';

dotenv.config();

// Base API URL
const API_BASE_URL = 'https://query.ampre.ca/odata';
const API_KEY = process.env.AMPERE_API_KEY;

// Create an axios client with default config
const apiClient = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Authorization': `Bearer ${API_KEY}`,
    'Accept': 'application/json'
  },
  timeout: 60000 // 60 second timeout
});

// Rate limiting variables
const MAX_RETRIES = 5;
const RETRY_DELAY_BASE = 2000; // 2 seconds

// Handle rate limiting with exponential backoff using proper headers
const handleRateLimit = async (error, retryCount) => {
  if (error.response && error.response.status === 429 && retryCount < MAX_RETRIES) {
    // Use the X-Rate-Limit-Retry-After-Seconds header as specified in AMPRE docs
    const retryAfterSeconds = parseInt(error.response.headers['x-rate-limit-retry-after-seconds'], 10);
    
    // If the header is present, use it, otherwise use exponential backoff
    const waitTime = retryAfterSeconds > 0
      ? retryAfterSeconds * 1000 
      : Math.pow(2, retryCount) * RETRY_DELAY_BASE;
    
    logger.warn(`Rate limit hit (429), retrying after ${waitTime/1000} seconds (attempt ${retryCount + 1}/${MAX_RETRIES})`);
    
    // Check remaining limit if available in header
    const remaining = error.response.headers['x-rate-limit-remaining'];
    if (remaining) {
      logger.warn(`Rate limit remaining: ${remaining} requests`);
    }
    
    // Wait for the specified time before retrying
    await new Promise(resolve => setTimeout(resolve, waitTime));
    return true;
  }
  return false;
};

// Get metadata to discover schema
export const getMetadata = async () => {
  let retryCount = 0;
  
  while (true) {
    try {
      const response = await apiClient.get('/$metadata?$format=json');
      return response.data;
    } catch (error) {
      if (await handleRateLimit(error, retryCount)) {
        retryCount++;
        continue;
      }
      
      logger.error('Failed to fetch metadata:', error);
      throw error;
    }
  }
};

// Get a specific property by ID
export const getPropertyById = async (propertyId) => {
  let retryCount = 0;
  
  while (true) {
    try {
      const response = await apiClient.get(`/Property('${propertyId}')`);
      return response.data;
    } catch (error) {
      if (await handleRateLimit(error, retryCount)) {
        retryCount++;
        continue;
      }
      
      logger.error(`Failed to fetch property ${propertyId}:`, error);
      throw error;
    }
  }
};

// Get a batch of properties using timestamp replication
export const getPropertyBatch = async (lastTimestamp, lastKey, batchSize = 1000) => {
  let retryCount = 0;
  
  // Validate and cap batchSize based on AMPRE limits
  const maxBatchSize = 10000; // AMPRE supports up to 10,000 records per request
  const validatedBatchSize = Math.min(batchSize, maxBatchSize);
  
  if (batchSize > maxBatchSize) {
    logger.warn(`Requested batch size ${batchSize} exceeds AMPRE limit of ${maxBatchSize}. Using maximum allowed.`);
  }
  
  while (true) {
    try {
      // Build query string
      const filter = encodeURIComponent(
        `ModificationTimestamp gt ${lastTimestamp} or (ModificationTimestamp eq ${lastTimestamp} and ListingKey gt '${lastKey}')`
      );
      const orderBy = encodeURIComponent('ModificationTimestamp,ListingKey');
      
      const url = `/Property?$filter=${filter}&$orderby=${orderBy}&$top=${validatedBatchSize}`;
      
      const response = await apiClient.get(url);
      
      // Check remaining rate limit if available
      const remainingRequests = response.headers['x-rate-limit-remaining'];
      if (remainingRequests && parseInt(remainingRequests, 10) < 1000) {
        logger.warn(`Rate limit running low: ${remainingRequests} requests remaining`);
      }
      
      // Response data is in .value property
      return {
        items: response.data.value,
        count: response.data.value.length
      };
    } catch (error) {
      if (await handleRateLimit(error, retryCount)) {
        retryCount++;
        continue;
      }
      
      logger.error('Failed to fetch property batch:', error);
      throw error;
    }
  }
};

// Count the total number of properties to be replicated
export const countProperties = async (lastTimestamp, lastKey) => {
  let retryCount = 0;
  
  while (true) {
    try {
      // Build query string
      const filter = encodeURIComponent(
        `ModificationTimestamp gt ${lastTimestamp} or (ModificationTimestamp eq ${lastTimestamp} and ListingKey gt '${lastKey}')`
      );
      
      const url = `/Property/$count?$filter=${filter}`;
      
      const response = await apiClient.get(url);
      return parseInt(response.data, 10);
    } catch (error) {
      if (await handleRateLimit(error, retryCount)) {
        retryCount++;
        continue;
      }
      
      logger.error('Failed to count properties:', error);
      throw error;
    }
  }
};

// Get media for a property
export const getPropertyMedia = async (propertyId) => {
  let retryCount = 0;
  
  while (true) {
    try {
      // Use direct Media endpoint with filter based on AMPRE documentation
      // Media records are linked by ResourceRecordKey and ResourceName
      const filter = encodeURIComponent(`ResourceRecordKey eq '${propertyId}' and ResourceName eq 'Property'`);
      const url = `/Media?$filter=${filter}&$orderby=ModificationTimestamp,MediaKey`;
      const response = await apiClient.get(url);
      
      return response.data.value;
    } catch (error) {
      if (await handleRateLimit(error, retryCount)) {
        retryCount++;
        continue;
      }
      
      // Return empty array for 404s - listing has no media
      if (error.response && error.response.status === 404) {
        logger.debug(`No media found for property ${propertyId} (404 response)`);
        return [];
      }
      
      logger.error(`Failed to fetch media for property ${propertyId}:`, error);
      throw error;
    }
  }
};

/**
 * Gets media for multiple properties in a batch operation
 * This is more efficient than fetching media for each property individually
 * 
 * @param {string[]} propertyIds - Array of property IDs to fetch media for
 * @returns {Object} - Object mapping property IDs to arrays of media items
 */
export const getMediaBatch = async (propertyIds) => {
  if (!propertyIds || propertyIds.length === 0) {
    return {};
  }
  
  try {
    // Prepare URL for batch media query
    // AMPRE API allows filtering media by multiple ListingKey values using 'in' operator
    const ids = propertyIds.map(id => `'${id}'`).join(',');
    const url = new URL(`${API_BASE_URL}/Media`);
    
    // Create parameters for the OData query
    url.searchParams.append('$filter', `ListingId in (${ids})`);
    url.searchParams.append('$orderby', 'Order'); // Sort by display order
    url.searchParams.append('$top', '1000'); // Limit results
    
    // Call API with retry logic
    const response = await apiClient.get(url.toString());
    
    // Process response
    if (response.status === 200) {
      const data = response.data;
      
      // Check if we got valid data
      if (!data || !data.value || !Array.isArray(data.value)) {
        logger.warn(`Invalid media batch response for ${propertyIds.length} properties`);
        return {};
      }
      
      // Process rate limit headers
      const remainingRequests = response.headers['x-rate-limit-remaining'];
      if (remainingRequests && parseInt(remainingRequests, 10) < 1000) {
        logger.warn(`Rate limit running low: ${remainingRequests} requests remaining`);
      }
      
      // Group media items by ListingId
      const mediaByProperty = {};
      
      for (const item of data.value) {
        const listingId = item.ListingId;
        
        if (!mediaByProperty[listingId]) {
          mediaByProperty[listingId] = [];
        }
        
        mediaByProperty[listingId].push(item);
      }
      
      logger.debug(`Retrieved ${data.value.length} media items for ${Object.keys(mediaByProperty).length} properties`);
      return mediaByProperty;
    } 
    else if (response.status === 404) {
      // No media found is a valid state
      logger.debug(`No media found for batch of ${propertyIds.length} properties`);
      return {};
    }
    else {
      // Handle other error responses
      const errorText = response.data;
      logger.error(`Failed to get media batch for ${propertyIds.length} properties: ${response.status} - ${errorText}`);
      throw new Error(`Media batch request failed with status ${response.status}`);
    }
  } catch (error) {
    logger.error(`Error fetching media batch for ${propertyIds.length} properties:`, error);
    // Return empty result on error to allow processing to continue
    return {};
  }
};

/**
 * Gets properties that have media changes based on special timestamps
 * According to AMPRE documentation, media changes are tracked by:
 * - PhotosChangeTimestamp
 * - DocumentsChangeTimestamp
 * - MediaChangeTimestamp
 * These timestamps do NOT update the main ModificationTimestamp
 */
export const getPropertiesWithMediaChanges = async () => {
  const client = await global.pool.connect();
  
  try {
    // Get the last media check timestamp
    const { lastTimestamp } = await getReplicationState('Media');
    
    // Find properties that might have media changes by checking the 
    // special timestamps in raw JSON
    const result = await client.query(`
      SELECT id, 
        raw->>'PhotosChangeTimestamp' as photos_timestamp,
        raw->>'DocumentsChangeTimestamp' as docs_timestamp,
        raw->>'MediaChangeTimestamp' as media_timestamp
      FROM listings
      WHERE 
        (
          (raw->>'PhotosChangeTimestamp' IS NOT NULL AND raw->>'PhotosChangeTimestamp' > $1)
          OR 
          (raw->>'DocumentsChangeTimestamp' IS NOT NULL AND raw->>'DocumentsChangeTimestamp' > $1)
          OR 
          (raw->>'MediaChangeTimestamp' IS NOT NULL AND raw->>'MediaChangeTimestamp' > $1)
        )
      ORDER BY id
      LIMIT 5000
    `, [lastTimestamp]);
    
    logger.info(`Found ${result.rows.length} properties with media changes since ${lastTimestamp}`);
    
    return result.rows.map(row => row.id);
  } catch (error) {
    logger.error('Failed to find properties with media changes:', error);
    throw error;
  } finally {
    client.release();
  }
};

/**
 * Updates media for a list of property IDs
 * Used specifically for the media-only update mode
 * 
 * @param {string[]} propertyIds - List of property IDs to update media for
 */
export const updateMediaForProperties = async (propertyIds) => {
  if (!propertyIds || propertyIds.length === 0) {
    return { mediaProcessed: 0, listingsWithMedia: 0, duration: 0, rate: 0 };
  }
  
  const startTime = Date.now();
  let totalMediaProcessed = 0;
  let listingsWithMedia = 0;
  
  // Split the property IDs into batches for better performance
  const batchSize = 50;
  
  for (let i = 0; i < propertyIds.length; i += batchSize) {
    const batchIds = propertyIds.slice(i, i + batchSize);
    
    try {
      // Get media for these properties in a batch
      const mediaByProperty = await getMediaBatch(batchIds);
      
      // Process media updates
      for (const propertyId in mediaByProperty) {
        const mediaItems = mediaByProperty[propertyId];
        
        if (mediaItems && mediaItems.length > 0) {
          console.log(`Updating ${mediaItems.length} media items for property ${propertyId}`);
          
          // Create a list of media keys for this property
          const mediaKeys = [];
          let preferredMediaKey = null;
          
          // Process the media items
          const mediaResults = await Promise.all(
            mediaItems.map(async (mediaItem) => {
              try {
                // Make sure the listing exists before processing its media
                const listingExists = await isListingInDatabase(propertyId);
                
                if (!listingExists) {
                  logger.warn(`Cannot store media for listing ${propertyId} as the listing does not exist in database`);
                  return false;
                }
                
                const mediaData = {
                  media_key: mediaItem.MediaKey,
                  listing_id: propertyId,
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
                
                // Track media keys and preferred media
                mediaKeys.push(mediaItem.MediaKey);
                if (mediaItem.PreferredPhotoYN === true) {
                  preferredMediaKey = mediaItem.MediaKey;
                }
                
                await upsertMedia(mediaData);
                return true;
              } catch (error) {
                logger.error(`Failed to process media ${mediaItem.MediaKey} for listing ${propertyId}:`, error);
                return false;
              }
            })
          );
          
          // Count successful updates
          const successCount = mediaResults.filter(Boolean).length;
          totalMediaProcessed += successCount;
          
          // Update the property's media_keys array
          if (successCount > 0) {
            listingsWithMedia++;
            
            // Find preferred media if not set yet
            if (!preferredMediaKey && mediaKeys.length > 0) {
              preferredMediaKey = mediaKeys[0];
            }
            
            // Update the listing
            try {
              const updateClient = await global.pool.connect();
              await updateClient.query(`
                UPDATE listings
                SET media_keys = $1,
                    preferred_media_key = $2,
                    updated_at = NOW()
                WHERE id = $3
              `, [mediaKeys, preferredMediaKey, propertyId]);
              updateClient.release();
              
              console.log(`Updated property ${propertyId} with ${mediaKeys.length} media keys`);
            } catch (error) {
              logger.error(`Failed to update media keys for property ${propertyId}:`, error);
            }
          }
        }
      }
    } catch (error) {
      logger.error(`Failed to process media batch for ${batchIds.length} properties:`, error);
    }
    
    // Log progress
    console.log(`Processed media for ${i + batchSize} of ${propertyIds.length} properties`);
  }
  
  // Calculate statistics
  const durationSeconds = (Date.now() - startTime) / 1000;
  const recordsPerSecond = durationSeconds > 0 ? Math.round((totalMediaProcessed / durationSeconds) * 100) / 100 : 0;
  
  return {
    mediaProcessed: totalMediaProcessed,
    listingsWithMedia,
    duration: durationSeconds,
    rate: recordsPerSecond
  };
};