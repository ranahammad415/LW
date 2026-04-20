/**
 * MySQL Database Setup Script
 * 
 * This script creates the MySQL database if it doesn't exist.
 * 
 * Usage: node prisma/setup-mysql.js
 */

import mysql from 'mysql2/promise';

const databaseUrl = process.env.DATABASE_URL || 'mysql://root:@localhost:3306/agency_portal';

// Parse connection string
function parseConnectionString(url) {
  // Handle empty password case: mysql://root:@localhost:3306/dbname
  const match = url.match(/mysql:\/\/([^:]+):([^@]*)@([^:]+):(\d+)\/(.+)/);
  if (!match) {
    throw new Error('Invalid DATABASE_URL format');
  }
  return {
    user: match[1],
    password: match[2],
    host: match[3],
    port: parseInt(match[4]),
    database: match[5],
  };
}

async function setupDatabase() {
  const config = parseConnectionString(databaseUrl);
  const dbName = config.database;
  
  console.log(`Setting up MySQL database: ${dbName}`);
  console.log(`Host: ${config.host}:${config.port}`);
  console.log(`User: ${config.user}\n`);
  
  // Connect without database to create it
  const connection = await mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
  });
  
  try {
    // Create database if it doesn't exist
    await connection.execute(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    console.log(`✓ Database '${dbName}' created or already exists`);
    
    // Show databases
    const [rows] = await connection.execute('SHOW DATABASES');
    console.log(`\nAvailable databases:`);
    rows.forEach(row => {
      if (row.Database === dbName) {
        console.log(`  → ${row.Database} (selected)`);
      } else {
        console.log(`    ${row.Database}`);
      }
    });
    
    console.log(`\n✓ MySQL setup complete!`);
    console.log(`\nNext steps:`);
    console.log(`  1. Run: npx prisma db push`);
    console.log(`  2. Run: node prisma/migrate-import.js`);
    
  } catch (error) {
    console.error('Error setting up database:', error.message);
    process.exit(1);
  } finally {
    await connection.end();
  }
}

setupDatabase();
