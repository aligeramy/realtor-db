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
  timeout: parseInt(process.env.API_TIMEOUT || '60000', 10) // Default 60 second timeout
});

// Circuit breaker implementation
class CircuitBreaker {
  constructor(options = {}) {
    this.name = options.name || 'API';
    this.state = 'CLOSED'; // CLOSED = normal, OPEN = failing, HALF_OPEN = testing
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = null;
    this.threshold = options.threshold || 10;
    this.resetTimeout = options.resetTimeout || 60000; // 1 minute
  }

  async execute(fn) {
    // If circuit is open, check if we should try again
    if (this.state === 'OPEN') {
      if (Date.now() > this.lastFailureTime + this.resetTimeout) {
        // Move to half-open state and try the request
        this.state = 'HALF_OPEN';
        logger.info(`${this.name} circuit breaker moving to HALF_OPEN state`);
      } else {
        // Circuit still open, fast fail
        throw new Error(`Circuit breaker open - ${this.name} service unavailable`);
      }
    }

    try {
      // Execute the function
      const result = await fn();
      
      // If successful in half-open state, reset the circuit
      if (this.state === 'HALF_OPEN') {
        this.successCount++;
        
        // Reset after 3 successful requests
        if (this.successCount >= 3) {
          this.reset();
        }
      }
      
      return result;
    } catch (error) {
      // Don't count rate limit errors toward circuit breaking
      if (error.response && error.response.status === 429) {
        throw error; // Just pass through rate limit errors
      }
      
      // Record the failure
      this.failureCount++;
      this.lastFailureTime = Date.now();
      
      // If we hit the threshold, open the circuit
      if ((this.state === 'CLOSED' && this.failureCount >= this.threshold) || 
          (this.state === 'HALF_OPEN')) {
        this.state = 'OPEN';
        logger.warn(`${this.name} circuit breaker OPEN after ${this.failureCount} failures`);
      }
      
      throw error;
    }
  }

  reset() {
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.successCount = 0;
    logger.info(`${this.name} circuit breaker reset to CLOSED state`);
  }
}

// Create circuit breaker instances for different API operations
const propertyCircuit = new CircuitBreaker({ name: 'Property API' });
const mediaCircuit = new CircuitBreaker({ name: 'Media API' });

// Rate limiting configuration
const MAX_RETRIES = parseInt(process.env.API_MAX_RETRIES || '5', 10);
const RETRY_DELAY_BASE = parseInt(process.env.API_RETRY_DELAY || '2000', 10); // 2 seconds
const MEDIA_TIMEOUT = parseInt(process.env.MEDIA_TIMEOUT || '30000', 10); // 30 seconds for media requests

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
  
  return propertyCircuit.execute(async () => {
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
  });
};

// Get a specific property by ID
export const getPropertyById = async (propertyId) => {
  let retryCount = 0;
  
  return propertyCircuit.execute(async () => {
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
  });
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
  
  return propertyCircuit.execute(async () => {
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
  });
};

// Count the total number of properties to be replicated
export const countProperties = async (lastTimestamp, lastKey) => {
  let retryCount = 0;
  
  return propertyCircuit.execute(async () => {
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
  });
};

// Rate limiter for media requests
// This uses the token bucket algorithm
class RateLimiter {
  constructor(tokensPerSecond = 20) {
    this.tokensPerSecond = tokensPerSecond;
    this.tokens = tokensPerSecond;
    this.lastRefill = Date.now();
    this.pendingRequests = [];
  }
  
  async getToken() {
    this.refillTokens();
    
    // If we have a token available, use it immediately
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return Promise.resolve();
    }
    
    // Otherwise, wait for a token to become available
    return new Promise(resolve => {
      this.pendingRequests.push(resolve);
    });
  }
  
  refillTokens() {
    const now = Date.now();
    const elapsedMs = now - this.lastRefill;
    
    if (elapsedMs > 0) {
      // Calculate how many tokens to add based on elapsed time
      const newTokens = (elapsedMs / 1000) * this.tokensPerSecond;
      this.tokens = Math.min(this.tokensPerSecond, this.tokens + newTokens);
      this.lastRefill = now;
      
      // Process any pending requests if we have tokens
      while (this.tokens >= 1 && this.pendingRequests.length > 0) {
        this.tokens -= 1;
        const resolve = this.pendingRequests.shift();
        resolve();
      }
    }
  }
}

// Create a media request rate limiter
const mediaRateLimiter = new RateLimiter(
  parseInt(process.env.MEDIA_REQUESTS_PER_SECOND || '20', 10)
);

// Get media for a property
export const getPropertyMedia = async (propertyId) => {
  let retryCount = 0;
  const MAX_RETRIES = 3;
  
  // Use the rate limiter to control API call rate
  await mediaRateLimiter.getToken();
  
  return mediaCircuit.execute(async () => {
    while (retryCount < MAX_RETRIES) {
      try {
        // Use direct Media endpoint with filter based on AMPRE documentation
        // Media records are linked by ResourceRecordKey and ResourceName
        const filter = encodeURIComponent(`ResourceRecordKey eq '${propertyId}' and ResourceName eq 'Property'`);
        const url = `/Media?$filter=${filter}&$orderby=Order,MediaKey`;
        
        // Use a shorter timeout but retry on failure
        const response = await apiClient.get(url, {
          timeout: MEDIA_TIMEOUT
        });
        
        return response.data.value;
      } catch (error) {
        if (error.code === 'ECONNABORTED' || (error.message && error.message.includes('timeout'))) {
          retryCount++;
          logger.warn(`Timeout while fetching media for property ${propertyId}, retry ${retryCount}/${MAX_RETRIES}`);
          
          if (retryCount >= MAX_RETRIES) {
            logger.warn(`Max retries reached for property ${propertyId}, skipping media`);
            return [];
          }
          
          // Wait briefly before retry
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_BASE * retryCount));
          continue;
        }
        
        // Handle rate limiting
        if (error.response && error.response.status === 429) {
          const retryAfter = parseInt(error.response.headers['x-rate-limit-retry-after-seconds'] || '5', 10);
          logger.warn(`Rate limit hit for property ${propertyId}, waiting ${retryAfter} seconds`);
          await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
          continue;
        }
        
        // Return empty array for 404s - listing has no media
        if (error.response && error.response.status === 404) {
          logger.debug(`No media found for property ${propertyId} (404 response)`);
          return [];
        }
        
        // For other errors, log and return empty to keep the process moving
        logger.error(`Failed to fetch media for property ${propertyId}:`, error.message || error);
        throw error; // Let the circuit breaker handle this
      }
    }
    
    return []; // Fallback empty result
  }).catch(error => {
    // Special handling for circuit breaker failures
    if (error.message && error.message.includes('Circuit breaker open')) {
      logger.warn(`Media circuit breaker open, returning empty results for ${propertyId}`);
      return [];
    }
    return [];
  });
};

// Get a single media item by ID - useful for retries
export const fetchMedia = async (url) => {
  let retryCount = 0;
  const MAX_RETRIES = 3;
  
  // Use the rate limiter to control API call rate
  await mediaRateLimiter.getToken();
  
  return mediaCircuit.execute(async () => {
    while (retryCount < MAX_RETRIES) {
      try {
        const response = await apiClient.get(url, {
          timeout: MEDIA_TIMEOUT
        });
        
        // Return the response data, which might be a single object or an array in .value
        return response.data;
      } catch (error) {
        if (error.code === 'ECONNABORTED' || (error.message && error.message.includes('timeout'))) {
          retryCount++;
          logger.warn(`Timeout while fetching media ${url}, retry ${retryCount}/${MAX_RETRIES}`);
          
          if (retryCount >= MAX_RETRIES) {
            logger.warn(`Max retries reached for media ${url}`);
            throw error;
          }
          
          // Wait briefly before retry with exponential backoff
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_BASE * Math.pow(2, retryCount - 1)));
          continue;
        }
        
        // Handle rate limiting
        if (error.response && error.response.status === 429) {
          const retryAfter = parseInt(error.response.headers['x-rate-limit-retry-after-seconds'] || '5', 10);
          logger.warn(`Rate limit hit for media ${url}, waiting ${retryAfter} seconds`);
          await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
          continue;
        }
        
        // Throw other errors to be handled by caller
        throw error;
      }
    }
    
    throw new Error(`Max retries exceeded for media ${url}`);
  });
};

// Get a single media item detail
export const getMediaDetail = async (mediaUrl) => {
  try {
    const response = await fetchMedia(mediaUrl);
    return response;
  } catch (error) {
    logger.error(`Failed to fetch media detail for ${mediaUrl}:`, error.message || error);
    return null;
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
  
  // Process properties with controlled concurrency to avoid overwhelming API
  const mediaByProperty = {};
  
  // Using smaller batch sizes and adding delay between batches for stability
  const BATCH_SIZE = parseInt(process.env.MEDIA_BATCH_SIZE || '5', 10);
  const BATCH_DELAY = parseInt(process.env.MEDIA_BATCH_DELAY || '500', 10); // 500ms delay between batches
  const CONCURRENCY = parseInt(process.env.MEDIA_CONCURRENCY || '3', 10); // Process 3 properties at a time
  
  // Process in batches with controlled concurrency
  for (let i = 0; i < propertyIds.length; i += BATCH_SIZE) {
    const batch = propertyIds.slice(i, i + BATCH_SIZE);
    const results = [];
    
    // Process batch with concurrency control
    for (let j = 0; j < batch.length; j += CONCURRENCY) {
      const concurrentBatch = batch.slice(j, j + CONCURRENCY);
      
      // Process each property in parallel limited by concurrency
      const promises = concurrentBatch.map(async (propertyId) => {
        try {
          const mediaItems = await getPropertyMedia(propertyId);
          
          if (mediaItems && mediaItems.length > 0) {
            return { propertyId, mediaItems };
          }
          return { propertyId, mediaItems: [] };
        } catch (error) {
          logger.error(`Failed to fetch media for property ${propertyId}:`, error);
          return { propertyId, mediaItems: [], error };
        }
      });
      
      // Wait for all concurrent requests to complete
      const batchResults = await Promise.all(promises);
      results.push(...batchResults);
      
      // Small delay between concurrent batches if more remain
      if (j + CONCURRENCY < batch.length) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
    
    // Process results
    for (const result of results) {
      if (result.mediaItems.length > 0) {
        mediaByProperty[result.propertyId] = result.mediaItems;
      }
    }
    
    // Add delay between main batches to avoid overwhelming the network
    if (i + BATCH_SIZE < propertyIds.length) {
      await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
    }
  }
  
  logger.debug(`Retrieved media for ${Object.keys(mediaByProperty).length} properties`);
  return mediaByProperty;
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
  const batchSize = parseInt(process.env.MEDIA_UPDATE_BATCH_SIZE || '50', 10);
  
  for (let i = 0; i < propertyIds.length; i += batchSize) {
    const batchIds = propertyIds.slice(i, i + batchSize);
    
    try {
      // Get media for these properties in a batch
      const mediaByProperty = await getMediaBatch(batchIds);
      
      // Process media updates
      const mediaUpdatePromises = [];
      
      for (const propertyId in mediaByProperty) {
        const mediaItems = mediaByProperty[propertyId];
        
        if (mediaItems && mediaItems.length > 0) {
          logger.info(`Updating ${mediaItems.length} media items for property ${propertyId}`);
          
          // Create a list of media keys for this property
          const mediaKeys = [];
          let preferredMediaKey = null;
          
          // Process the media items in batches to avoid overwhelming the database
          const mediaItemBatches = [];
          const MEDIA_ITEM_BATCH_SIZE = 20;
          
          for (let j = 0; j < mediaItems.length; j += MEDIA_ITEM_BATCH_SIZE) {
            mediaItemBatches.push(mediaItems.slice(j, j + MEDIA_ITEM_BATCH_SIZE));
          }
          
          for (const mediaItemBatch of mediaItemBatches) {
            // Create a promise for each batch of media items
            mediaUpdatePromises.push(
              (async () => {
                try {
                  // Make sure the listing exists before processing its media
                  const listingExists = await isListingInDatabase(propertyId);
                  
                  if (!listingExists) {
                    logger.warn(`Cannot store media for listing ${propertyId} as the listing does not exist in database`);
                    return { success: false, propertyId };
                  }
                  
                  // Process media items in this batch
                  const batchResults = await Promise.all(
                    mediaItemBatch.map(async (mediaItem) => {
                      try {
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
                        return { success: true, mediaKey: mediaItem.MediaKey };
                      } catch (error) {
                        logger.error(`Failed to process media ${mediaItem.MediaKey} for listing ${propertyId}:`, error);
                        return { success: false, mediaKey: mediaItem.MediaKey, error };
                      }
                    })
                  );
                  
                  // Count successful updates
                  const successCount = batchResults.filter(result => result.success).length;
                  totalMediaProcessed += successCount;
                  
                  // Update the property's media_keys array if any media was processed
                  if (successCount > 0) {
                    // This will be handled outside the batch processing
                    return { 
                      success: true, 
                      propertyId, 
                      mediaKeys, 
                      preferredMediaKey: preferredMediaKey || (mediaKeys.length > 0 ? mediaKeys[0] : null),
                      successCount
                    };
                  }
                  
                  return { success: false, propertyId };
                } catch (error) {
                  logger.error(`Failed to process media batch for property ${propertyId}:`, error);
                  return { success: false, propertyId, error };
                }
              })()
            );
          }
        }
      }
      
      // Wait for all media update promises to complete
      const mediaUpdateResults = await Promise.all(mediaUpdatePromises);
      
      // Collect results by property ID for database updates
      const resultsByProperty = {};
      
      for (const result of mediaUpdateResults) {
        if (result.success) {
          if (!resultsByProperty[result.propertyId]) {
            resultsByProperty[result.propertyId] = {
              mediaKeys: [],
              preferredMediaKey: null,
              successCount: 0
            };
          }
          
          resultsByProperty[result.propertyId].mediaKeys.push(...result.mediaKeys);
          
          // Set preferred key if not set yet
          if (!resultsByProperty[result.propertyId].preferredMediaKey && result.preferredMediaKey) {
            resultsByProperty[result.propertyId].preferredMediaKey = result.preferredMediaKey;
          }
          
          resultsByProperty[result.propertyId].successCount += result.successCount;
        }
      }
      
      // Update the database for each property
      const dbUpdatePromises = [];
      
      for (const propertyId in resultsByProperty) {
        const result = resultsByProperty[propertyId];
        
        if (result.successCount > 0) {
          listingsWithMedia++;
          
          // Update the listing with all media keys
          dbUpdatePromises.push(
            (async () => {
              try {
                const updateClient = await global.pool.connect();
                await updateClient.query(`
                  UPDATE listings
                  SET media_keys = $1,
                      preferred_media_key = $2,
                      updated_at = NOW()
                  WHERE id = $3
                `, [
                  result.mediaKeys,
                  result.preferredMediaKey || (result.mediaKeys.length > 0 ? result.mediaKeys[0] : null),
                  propertyId
                ]);
                updateClient.release();
                
                logger.info(`Updated property ${propertyId} with ${result.mediaKeys.length} media keys`);
                return { success: true, propertyId };
              } catch (error) {
                logger.error(`Failed to update media keys for property ${propertyId}:`, error);
                return { success: false, propertyId, error };
              }
            })()
          );
        }
      }
      
      // Wait for all database updates to complete
      await Promise.all(dbUpdatePromises);
    } catch (error) {
      logger.error(`Failed to process media batch for ${batchIds.length} properties:`, error);
    }
    
    // Log progress
    const processedCount = Math.min(i + batchSize, propertyIds.length);
    logger.info(`Processed media for ${processedCount} of ${propertyIds.length} properties (${Math.round(processedCount / propertyIds.length * 100)}%)`);
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