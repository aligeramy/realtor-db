import { replicateProperties, replicateMedia } from '../services/sequential-replication.js';
import { getPropertiesWithMediaChanges, updateMediaForProperties } from '../services/ampre-api.js';
import { getReplicationState, updateReplicationState } from '../db/index.js';
import { logger } from '../utils/logger.js';
import dotenv from 'dotenv';

dotenv.config();

// Set environment variables for optimized performance
process.env.REPLICATION_BATCH_SIZE = process.env.REPLICATION_BATCH_SIZE || '5000'; // Use larger batch size 
process.env.REPLICATION_CONCURRENCY = process.env.REPLICATION_CONCURRENCY || '50';  // Higher concurrency
process.env.REPLICATION_MAX_RECORDS = process.env.REPLICATION_MAX_RECORDS || '0';   // No limit
process.env.SYNC_INTERVAL_MINUTES = process.env.SYNC_INTERVAL_MINUTES || '5';      // Default to 5 minute sync interval

// Define the sync modes
const SYNC_MODES = {
  FULL: 'full',              // Complete replication of properties and media
  INCREMENTAL: 'incremental', // Standard incremental updates based on ModificationTimestamp
  MEDIA_ONLY: 'media-only'    // Only update media for properties with media changes
};

/**
 * Runs the optimized replication process with a specified mode
 * @param {string} mode - The sync mode (full, incremental, media-only)
 */
async function runOptimizedReplication(mode = SYNC_MODES.INCREMENTAL) {
  try {
    console.log('Starting high-performance replication process...');
    console.log(`Mode: ${mode}`);
    console.log(`Batch size: ${process.env.REPLICATION_BATCH_SIZE}`);
    console.log(`Concurrency: ${process.env.REPLICATION_CONCURRENCY}`);
    
    const startTime = Date.now();
    let propertyResult = { processed: 0, duration: 0, rate: 0 };
    let mediaResult = { mediaProcessed: 0, listingsWithMedia: 0, duration: 0, rate: 0 };
    
    // Get current states
    const propertyState = await getReplicationState('Property');
    const mediaState = await getReplicationState('Media');
    
    // Run the appropriate replication based on mode
    if (mode === SYNC_MODES.FULL) {
      // Phase 1: Full properties replication
      propertyResult = await replicateProperties();
      
      // Phase 2: Full media replication
      mediaResult = await replicateMedia();
    } 
    else if (mode === SYNC_MODES.INCREMENTAL) {
      // Standard incremental update based on ModificationTimestamp
      propertyResult = await replicateProperties();
      
      // Process media only for properties that were updated
      if (propertyResult.processed > 0) {
        mediaResult = await replicateMedia();
      }
    }
    else if (mode === SYNC_MODES.MEDIA_ONLY) {
      // Special mode for updating only media based on MediaChangeTimestamp
      // This is important as per AMPRE docs: MediaChangeTimestamp DOES NOT change ModificationTimestamp
      const mediaChangeStart = Date.now();
      console.log('Starting media-only replication based on media change timestamps...');
      
      try {
        // Find properties with media changes (based on PhotosChangeTimestamp, DocumentsChangeTimestamp, or MediaChangeTimestamp)
        const propertiesWithMediaChanges = await getPropertiesWithMediaChanges();
        
        if (propertiesWithMediaChanges.length > 0) {
          console.log(`Found ${propertiesWithMediaChanges.length} properties with media changes`);
          
          // Process media updates for these properties
          mediaResult = await updateMediaForProperties(propertiesWithMediaChanges);
          
          // Update media replication state
          await updateReplicationState('Media', new Date().toISOString(), '0', mediaResult.mediaProcessed);
        } else {
          console.log('No properties with media changes found');
        }
      } catch (error) {
        logger.error('Media-only replication failed:', error);
        console.error('Media-only replication failed:', error);
      }
      
      const mediaDuration = (Date.now() - mediaChangeStart) / 1000;
      console.log(`Media-only replication completed in ${mediaDuration.toFixed(2)}s`);
    }
    
    const totalDuration = (Date.now() - startTime) / 1000;
    
    console.log('\n===== Optimized Replication Complete =====');
    console.log(`Total duration: ${totalDuration.toFixed(2)}s`);
    
    if (mode !== SYNC_MODES.MEDIA_ONLY) {
      console.log(`\nPhase 1 (Properties):`);
      console.log(`- Properties processed: ${propertyResult.processed}`);
      console.log(`- Duration: ${propertyResult.duration.toFixed(2)}s`);
      console.log(`- Rate: ${propertyResult.rate} properties/sec`);
    }
    
    console.log(`\nPhase 2 (Media):`);
    console.log(`- Media items processed: ${mediaResult.mediaProcessed}`);
    console.log(`- Listings with media: ${mediaResult.listingsWithMedia}`);
    console.log(`- Duration: ${mediaResult.duration.toFixed(2)}s`);
    console.log(`- Rate: ${mediaResult.rate} media/sec`);
    
    const totalRecords = propertyResult.processed + mediaResult.mediaProcessed;
    if (totalRecords > 0) {
      // Calculate the potential throughput based on AMPRE limits
      const potentialPerMinute = 60000 / (totalDuration * 1000) * totalRecords;
      console.log(`\nEstimated system throughput: ${Math.round(potentialPerMinute)} records/minute`);
      console.log(`AMPRE rate limit: 60,000 requests/minute`);
    }
    
    console.log('\nReplication completed successfully!');
    
    return {
      properties: propertyResult,
      media: mediaResult,
      duration: totalDuration
    };
  } catch (error) {
    console.error('Replication failed:', error);
    logger.error('Replication failed:', error);
    throw error;
  }
}

/**
 * Decides which replication mode to use based on current state
 */
async function determineSyncMode() {
  try {
    // Get current states
    const propertyState = await getReplicationState('Property');
    const mediaState = await getReplicationState('Media');
    
    // Check if we need a full sync
    if (propertyState.lastTimestamp === '1970-01-01T00:00:00Z' && propertyState.lastKey === '0') {
      console.log('No previous replication state found, performing full sync...');
      return SYNC_MODES.FULL;
    }
    
    // Every 4th sync cycle, check for media changes that might be missed
    // This addresses the fact that media changes don't update ModificationTimestamp
    if (mediaState.recordsProcessed % 4 === 0) {
      console.log('Performing scheduled media-only sync to catch media changes...');
      return SYNC_MODES.MEDIA_ONLY;
    }
    
    // Default to standard incremental replication
    return SYNC_MODES.INCREMENTAL;
  } catch (error) {
    logger.error('Error determining sync mode:', error);
    // Default to incremental as safest fallback
    return SYNC_MODES.INCREMENTAL;
  }
}

/**
 * Run as a continuous process with intervals
 */
async function runContinuousSync() {
  try {
    // Initial sync
    const mode = await determineSyncMode();
    await runOptimizedReplication(mode);
    
    // Setup interval for continuous sync
    const intervalMinutes = parseInt(process.env.SYNC_INTERVAL_MINUTES, 10);
    const intervalMs = intervalMinutes * 60 * 1000;
    
    console.log(`\nScheduling next sync in ${intervalMinutes} minutes...`);
    
    // Schedule next run
    setTimeout(runContinuousSync, intervalMs);
  } catch (error) {
    logger.error('Continuous sync error:', error);
    console.error('Continuous sync error:', error);
    
    // Even if there's an error, try again after a delay
    const retryDelay = 60000; // 1 minute retry delay
    console.log(`Error occurred. Retrying in 1 minute...`);
    setTimeout(runContinuousSync, retryDelay);
  }
}

// Run as a one-time sync when called directly
if (process.argv[2] === '--once') {
  // Run once
  runOptimizedReplication()
    .then(() => process.exit(0))
    .catch(error => {
      console.error('One-time sync failed:', error);
      process.exit(1);
    });
} else if (process.argv[2] === '--mode' && process.argv[3]) {
  // Run with specified mode
  const mode = process.argv[3].toLowerCase();
  if (!Object.values(SYNC_MODES).includes(mode)) {
    console.error(`Invalid mode: ${mode}. Available modes: ${Object.values(SYNC_MODES).join(', ')}`);
    process.exit(1);
  }
  
  runOptimizedReplication(mode)
    .then(() => process.exit(0))
    .catch(error => {
      console.error(`${mode} sync failed:`, error);
      process.exit(1);
    });
} else {
  // Run continuously
  console.log(`Starting continuous sync service with ${process.env.SYNC_INTERVAL_MINUTES} minute intervals`);
  runContinuousSync();
} 