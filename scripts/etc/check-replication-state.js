import { pool } from '../../db/index.js';
import dotenv from 'dotenv';

dotenv.config();

async function checkReplicationState() {
  const client = await pool.connect();
  
  try {
    console.log('Checking replication state...');
    
    // Check replication_state table
    const result = await client.query(`
      SELECT * FROM replication_state
    `);
    
    if (result.rows.length === 0) {
      console.log('No replication state found - this means system will start from beginning');
    } else {
      console.log('Current replication state:');
      result.rows.forEach(row => {
        console.log(`Resource: ${row.resource_name}`);
        console.log(`Last timestamp: ${row.last_timestamp}`);
        console.log(`Last key: ${row.last_key}`);
        console.log(`Records processed: ${row.records_processed}`);
        console.log(`Last run: ${row.last_run_at}`);
        console.log('---');
      });
    }
    
    // Check when listings were last updated
    const listingsResult = await client.query(`
      SELECT MIN(modification_timestamp) as oldest, 
             MAX(modification_timestamp) as newest,
             NOW() - MAX(modification_timestamp) as age
      FROM listings
    `);
    
    if (listingsResult.rows.length > 0) {
      console.log('\nListings timestamp range:');
      console.log(`Oldest: ${listingsResult.rows[0].oldest}`);
      console.log(`Newest: ${listingsResult.rows[0].newest}`);
      console.log(`Age of newest record: ${listingsResult.rows[0].age}`);
    }
    
    // Get latest listing IDs to check for discrepancies
    const latestListings = await client.query(`
      SELECT id, modification_timestamp 
      FROM listings 
      ORDER BY modification_timestamp DESC 
      LIMIT 3
    `);
    
    console.log('\nLatest listings:');
    latestListings.rows.forEach(row => {
      console.log(`ID: ${row.id}, Timestamp: ${row.modification_timestamp}`);
    });
    
  } catch (error) {
    console.error('Error checking replication state:', error);
  } finally {
    client.release();
    await pool.end();
  }
}

checkReplicationState(); 