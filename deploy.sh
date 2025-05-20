#!/bin/bash

# Property Listings Replicator Deployment Script

echo "Starting deployment..."

# Update system
apt update && apt upgrade -y

# Install Node.js if not already installed
if ! command -v node &> /dev/null; then
  echo "Installing Node.js..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt install -y nodejs
fi

# Install dependencies
apt install -y postgresql postgresql-contrib postgis git

# Install PM2 globally
npm install -g pm2

# Create deployment directory
mkdir -p /opt/property-replication
cd /opt/property-replication

# Clone or update repository (replace with your actual repository URL)
if [ -d ".git" ]; then
  echo "Updating existing repository..."
  git pull
else
  echo "Cloning repository..."
  git clone https://github.com/yourusername/property-replication.git .
fi

# Install Node dependencies
npm install

# Set up environment
if [ ! -f ".env" ]; then
  echo "Creating .env file..."
  cp .env.example .env
  # Edit .env with production values
  echo "Please edit .env with your production values"
fi

# Install cors package if not already included
npm install cors

# Apply Drizzle migrations (this handles schema creation, PostGIS extensions, and spatial indexes)
echo "Applying database migrations..."
npm run db:setup

# Start application with PM2
pm2 start ecosystem.config.js --env production
pm2 save

# Set up PM2 to start on system boot
pm2 startup

# Display running processes
echo "Current PM2 processes:"
pm2 list

echo "Deployment complete! API running on port 9696" 