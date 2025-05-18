#!/usr/bin/env node

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import dotenv from 'dotenv';
import { logger } from './utils/logger.js';

// Load environment variables
dotenv.config();

// Get the directory of the current module
const __dirname = dirname(fileURLToPath(import.meta.url));

// Path to the replication script
const scriptPath = path.join(__dirname, 'scripts', 'run-optimized-replication.js');

// Log startup
logger.info('Starting property replication service');
logger.info(`Using optimized replication script: ${scriptPath}`);

// Function to spawn the replication process
function startReplication() {
  try {
    // Log configuration
    logger.info(`Replication configuration:`);
    logger.info(`- Batch size: ${process.env.REPLICATION_BATCH_SIZE || '5000'}`);
    logger.info(`- Concurrency: ${process.env.REPLICATION_CONCURRENCY || '50'}`);
    logger.info(`- Sync interval: ${process.env.SYNC_INTERVAL_MINUTES || '5'} minutes`);
    
    // Launch the script as a child process
    const replicationProcess = spawn('node', [scriptPath], {
      stdio: 'inherit', // Inherit stdio from parent process
      env: process.env // Pass environment variables
    });
    
    // Handle process events
    replicationProcess.on('error', (error) => {
      logger.error(`Failed to start replication process: ${error.message}`);
      process.exit(1);
    });
    
    replicationProcess.on('exit', (code, signal) => {
      if (code !== 0) {
        logger.error(`Replication process exited with code ${code} and signal ${signal}`);
        // Restart after a short delay
        logger.info('Restarting replication process in 60 seconds...');
        setTimeout(startReplication, 60000);
      } else {
        logger.info('Replication process completed successfully');
      }
    });
    
    // Log the process ID
    logger.info(`Replication process started with PID: ${replicationProcess.pid}`);
  } catch (error) {
    logger.error(`Error starting replication: ${error.message}`);
    process.exit(1);
  }
}

// Start the replication process
startReplication();

// Handle graceful shutdown
const gracefulShutdown = async (signal) => {
  logger.info(`${signal} received, shutting down gracefully`);
  
  try {
    // Allow some time for logs to be written
    setTimeout(() => {
      process.exit(0);
    }, 1000);
  } catch (err) {
    logger.error('Error during graceful shutdown:', err);
    process.exit(1);
  }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions and rejections
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception:', err);
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection:', reason);
  // Don't exit for unhandled rejections, just log them
}); 