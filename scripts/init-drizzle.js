import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { logger } from '../utils/logger.js';

dotenv.config();

// Get directory of current module
const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(__dirname, '..', 'drizzle', 'migrations');

// Get connection config
const getConnectionConfig = () => {
  return {
    host: process.env.POSTGRES_HOST || '198.251.68.5',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    database: process.env.POSTGRES_DB || 'listings',
    user: process.env.POSTGRES_USER || 'pooya',
    password: process.env.POSTGRES_PASSWORD || 'hR72fW9nTqZxB3dMvgKpY1CsJeULoXNb',
    ssl: false
  };
};

// Initialize database with Drizzle
async function initDatabase() {
  logger.info('Initializing database with Drizzle...');
  
  try {
    // Create a PostgreSQL connection
    const config = getConnectionConfig();
    const pool = new pg.Pool(config);
    
    // Create Drizzle instance
    const db = drizzle(pool);
    
    // Run migrations
    logger.info(`Running migrations from ${migrationsFolder}`);
    await migrate(db, { migrationsFolder });
    
    logger.info('Database initialization completed successfully');
    
    // Close the pool
    await pool.end();
  } catch (error) {
    logger.error('Failed to initialize database:', error);
    process.exit(1);
  }
}

// Run the initialization
initDatabase(); 