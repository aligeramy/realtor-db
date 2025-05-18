import { pool } from '../../db/index.js';
import { logger } from '../../utils/logger.js';

async function checkDuplicates() {
  const client = await pool.connect();
  
  try {
    // Check total count
    const { rows: totalRows } = await client.query('SELECT COUNT(*) as total FROM listings');
    console.log(`Total listings in database: ${totalRows[0].total}`);
    
    // Check for duplicates
    const { rows: duplicateRows } = await client.query(`
      SELECT id, COUNT(*) as count 
      FROM listings 
      GROUP BY id 
      HAVING COUNT(*) > 1
    `);
    
    console.log(`Found ${duplicateRows.length} duplicate listing IDs`);
    
    if (duplicateRows.length > 0) {
      console.log('First 5 duplicates:');
      duplicateRows.slice(0, 5).forEach(row => {
        console.log(`ID: ${row.id}, Count: ${row.count}`);
      });
      
      // Get details for the first duplicate
      if (duplicateRows.length > 0) {
        const firstDuplicateId = duplicateRows[0].id;
        const { rows: detailRows } = await client.query(`
          SELECT id, modification_timestamp, created_at, updated_at
          FROM listings
          WHERE id = $1
        `, [firstDuplicateId]);
        
        console.log(`\nDetails for duplicate ID ${firstDuplicateId}:`);
        detailRows.forEach((row, i) => {
          console.log(`Copy ${i+1}: Modified: ${row.modification_timestamp}, Created: ${row.created_at}, Updated: ${row.updated_at}`);
        });
      }
    }
    
    // Compare with AMPRE API count (99715 from your curl command)
    const ampreCount = 99715;
    console.log(`\nAMPRE API reports: ${ampreCount} properties`);
    console.log(`Database contains: ${totalRows[0].total} properties`);
    console.log(`Difference: ${totalRows[0].total - ampreCount} properties`);
    
    if (totalRows[0].total > ampreCount) {
      console.log('\nPossible reasons for more records in database than API:');
      console.log('1. Duplicate entries in the database');
      console.log('2. Properties that have been removed from the API but remain in the database');
      console.log('3. API results are paginated or filtered');
    }
    
  } catch (error) {
    console.error('Error checking duplicates:', error);
  } finally {
    client.release();
    await pool.end();
  }
}

checkDuplicates(); 