#!/bin/bash

# Property Listings Replicator Deployment Script

echo "Starting deployment..."

# Update repository
echo "Updating code from repository..."
git pull

# Install dependencies
echo "Installing dependencies..."
npm install

# Check if PM2 is installed globally, if not install it
if ! command -v pm2 &> /dev/null; then
    echo "Installing PM2 globally..."
    npm install -g pm2
fi

# Stop existing processes if running
echo "Stopping existing PM2 processes..."
pm2 stop property-replicator incremental-updates 2>/dev/null || true

# Start or restart the application using PM2
echo "Starting application with PM2..."
pm2 start ecosystem.config.js

# Save PM2 configuration to start on system reboot
echo "Setting up PM2 to start on system reboot..."
pm2 save

# Display running processes
echo "Current PM2 processes:"
pm2 list

echo "Deployment complete!" 