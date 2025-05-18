import { pool } from '../../db/index.js';
import dotenv from 'dotenv';

dotenv.config();

async function createMediaReplicationState() {
  const client = await pool.connect();
  
  try {
    console.log('Creating media replication state entry...');
    
    // Check if media replication state already exists
    const checkResult = await client.query(`
      SELECT 1 FROM replication_state WHERE resource_name = 'Media'
    `);
    
    if (checkResult.rows.length > 0) {
      console.log('Media replication state already exists');
    } else {
      // Create media replication state entry
      const result = await client.query(`
        INSERT INTO replication_state (resource_name, last_timestamp, last_key, records_processed, last_run_at)
        VALUES ('Media', '1970-01-01T00:00:00Z', '0', 0, NOW())
      `);
      
      console.log('Created media replication state entry');
    }
    
    // Display all replication states
    const stateResult = await client.query(`
      SELECT * FROM replication_state ORDER BY resource_name
    `);
    
    console.log('\nCurrent replication states:');
    stateResult.rows.forEach(row => {
      console.log(`Resource: ${row.resource_name}`);
      console.log(`Last timestamp: ${row.last_timestamp}`);
      console.log(`Last key: ${row.last_key}`);
      console.log(`Records processed: ${row.records_processed}`);
      console.log(`Last run: ${row.last_run_at}`);
      console.log('---');
    });
    
  } catch (error) {
    console.error('Error creating media replication state:', error);
  } finally {
    client.release();
    await pool.end();
  }
}

createMediaReplicationState(); 