#!/bin/bash

# Property Listings Replicator Deployment Script

echo "Starting deployment..."

# Update system
apt update && apt upgrade -y

# Install dependencies
apt install -y postgresql postgresql-contrib

# Clone repository (replace with your actual repository URL)
git clone https://github.com/yourusername/property-replication.git /opt/property-replication
cd /opt/property-replication

# Install Node dependencies
npm install --production

# Set up environment
cp .env.example .env
# Edit .env with production values

# Generate Drizzle migrations
npm run drizzle:generate

# Initialize database
node scripts/init-drizzle.js

# Start application with PM2
pm2 start ecosystem.config.js --env production
pm2 save

# Set up PM2 to start on system boot
pm2 startup

# Display running processes
echo "Current PM2 processes:"
pm2 list

echo "Deployment complete!" 