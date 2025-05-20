#!/usr/bin/env node

/**
 * This script runs the address standardization process with configurable parameters.
 * It standardizes addresses for properties in the database without needing geocoding.
 * 
 * Usage:
 *   node scripts/run-address-standardization.js [options]
 * 
 * Options:
 *   --batch-size=100       Number of properties to process in each batch
 *   --max-batches=10       Maximum number of batches to process
 *   --enable-geocoding     Enable geocoding of addresses (default: disabled)
 *   --concurrency=5        Number of addresses to process concurrently
 *   --help                 Show this help message
 */

import dotenv from 'dotenv';
import { standardizeAddresses } from './standardize-addresses.js';
import { logger } from '../utils/logger.js';

// Load environment variables
dotenv.config();

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    batchSize: parseInt(process.env.ADDRESS_BATCH_SIZE || '100', 10),
    maxBatches: parseInt(process.env.ADDRESS_MAX_BATCHES || '10', 10),
    enableGeocoding: process.env.ENABLE_GEOCODING === 'true',
    concurrency: parseInt(process.env.GEOCODING_CONCURRENCY || '5', 10)
  };

  for (const arg of args) {
    if (arg === '--help') {
      showHelp();
      process.exit(0);
    } else if (arg.startsWith('--batch-size=')) {
      options.batchSize = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--max-batches=')) {
      options.maxBatches = parseInt(arg.split('=')[1], 10);
    } else if (arg === '--enable-geocoding') {
      options.enableGeocoding = true;
    } else if (arg.startsWith('--concurrency=')) {
      options.concurrency = parseInt(arg.split('=')[1], 10);
    }
  }

  return options;
}

// Show help message
function showHelp() {
  console.log(`
Address Standardization Script

This script standardizes addresses for properties in the database.
It can optionally geocode addresses to add latitude and longitude.

Usage:
  node scripts/run-address-standardization.js [options]

Options:
  --batch-size=100       Number of properties to process in each batch
  --max-batches=10       Maximum number of batches to process
  --enable-geocoding     Enable geocoding of addresses (default: disabled)
  --concurrency=5        Number of addresses to process concurrently
  --help                 Show this help message
  `);
}

// Main function
async function main() {
  const options = parseArgs();
  
  // Log options
  logger.info('Starting address standardization with options:');
  logger.info(`- Batch size: ${options.batchSize}`);
  logger.info(`- Max batches: ${options.maxBatches}`);
  logger.info(`- Geocoding: ${options.enableGeocoding ? 'Enabled' : 'Disabled'}`);
  logger.info(`- Concurrency: ${options.concurrency}`);
  
  // Set environment variable for script to use
  process.env.ENABLE_GEOCODING = options.enableGeocoding.toString();
  
  // Calculate estimated properties
  const estimatedProperties = options.batchSize * options.maxBatches;
  logger.info(`Estimated properties to process: ${estimatedProperties}`);
  
  // Run the address standardization
  try {
    console.time('Address Standardization');
    const result = await standardizeAddresses(options);
    console.timeEnd('Address Standardization');
    
    // Log results
    console.log('\nAddress Standardization Results:');
    console.log(`- Total properties processed: ${result.totalProcessed}`);
    console.log(`- Properties geocoded: ${result.totalGeocoded}`);
    console.log(`- Properties standardized without geocoding: ${result.totalStandardized}`);
    console.log(`- Properties skipped: ${result.totalSkipped}`);
    console.log(`- Properties failed: ${result.totalFailed}`);
    console.log(`- Batches processed: ${result.batchCount}`);
    
    // Calculate percentage
    if (result.totalProcessed > 0) {
      const successRate = ((result.totalGeocoded + result.totalStandardized) / result.totalProcessed * 100).toFixed(2);
      console.log(`- Success rate: ${successRate}%`);
    }
    
    process.exit(0);
  } catch (error) {
    logger.error(`Address standardization failed: ${error.message}`);
    process.exit(1);
  }
}

// Run the main function
main().catch(error => {
  console.error('Error:', error);
  process.exit(1);
}); 