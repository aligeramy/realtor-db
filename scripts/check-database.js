import { pool } from '../db/index.js';
import dotenv from 'dotenv';

dotenv.config();

async function checkDatabase() {
  const client = await pool.connect();
  
  try {
    console.log('Checking database...');
    
    // Check listings table
    const listingsResult = await client.query(`
      SELECT COUNT(*) as total, 
             COUNT(DISTINCT id) as unique_ids,
             MIN(id) as first_id, 
             MAX(id) as last_id
      FROM listings
    `);
    
    console.log('Listings table:');
    console.log(listingsResult.rows[0]);
    
    // Check media table
    const mediaResult = await client.query(`
      SELECT COUNT(*) as total, 
             COUNT(DISTINCT media_key) as unique_keys,
             COUNT(DISTINCT listing_id) as unique_listing_ids
      FROM listing_media
    `);
    
    console.log('\nMedia table:');
    console.log(mediaResult.rows[0]);
    
    // Check if we have the specific test property
    const testId = 'W11888339';
    const propertyResult = await client.query(`
      SELECT id, property_type, media_keys
      FROM listings 
      WHERE id = $1
    `, [testId]);
    
    if (propertyResult.rows.length > 0) {
      console.log(`\nFound test property ${testId}:`);
      console.log(propertyResult.rows[0]);
      
      // Check media for this property
      const propertyMediaResult = await client.query(`
        SELECT COUNT(*) as media_count
        FROM listing_media
        WHERE listing_id = $1
      `, [testId]);
      
      console.log(`Media count for ${testId}: ${propertyMediaResult.rows[0].media_count}`);
    } else {
      console.log(`\nTest property ${testId} not found in database`);
    }
    
    // Check for recent errors in foreign key constraints
    const recentMediaResult = await client.query(`
      SELECT listing_id, COUNT(*) as count
      FROM listing_media
      GROUP BY listing_id
      ORDER BY count DESC
      LIMIT 5
    `);
    
    console.log('\nTop 5 properties by media count:');
    console.log(recentMediaResult.rows);
    
  } catch (error) {
    console.error('Error checking database:', error);
  } finally {
    client.release();
    await pool.end();
  }
}

checkDatabase(); 