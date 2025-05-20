import winston from 'winston';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Figure out the current directory path
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOG_DIR = path.join(__dirname, '..', 'logs');

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// Configure log file paths
const ERROR_LOG = path.join(LOG_DIR, 'error.log');
const COMBINED_LOG = path.join(LOG_DIR, 'combined.log');
const MEDIA_LOG = path.join(LOG_DIR, 'media.log');
const GEOCODING_LOG = path.join(LOG_DIR, 'geocoding.log');

// Define a custom format that includes errors in a better way
const logFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ level, message, timestamp, stack }) => {
    // Include error stack trace if available
    if (stack) {
      return `${timestamp} ${level}: ${message}\n${stack}`;
    }
    return `${timestamp} ${level}: ${message}`;
  })
);

// Create a transport that rotates logs
const createFileTransport = (filename, level) => 
  new winston.transports.File({
    filename,
    level,
    maxsize: 10 * 1024 * 1024, // 10MB
    maxFiles: 5,
    tailable: true
  });

// Create logger instance
export const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: logFormat,
  defaultMeta: { service: 'property-replication' },
  transports: [
    // Console output in development
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ level, message, timestamp, stack }) => {
          if (stack) {
            return `${timestamp} ${level}: ${message}\n${stack}`;
          }
          return `${timestamp} ${level}: ${message}`;
        })
      )
    }),
    // File outputs for different log types
    createFileTransport(ERROR_LOG, 'error'),
    createFileTransport(COMBINED_LOG, 'info'),
    createFileTransport(MEDIA_LOG, 'debug')
  ]
});

// Add specialized loggers for specific components
export const mediaLogger = logger.child({ component: 'media' });
export const geocodingLogger = logger.child({ component: 'geocoding' });
export const dbLogger = logger.child({ component: 'database' });

// Handle uncaught exceptions
logger.exceptions.handle(
  new winston.transports.File({ filename: path.join(LOG_DIR, 'exceptions.log') })
);

// Log startup information
logger.info(`Logger initialized. Log files stored in: ${LOG_DIR}`);
logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
logger.info(`Log level: ${logger.level}`);

export default logger; 