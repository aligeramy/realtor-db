#!/bin/bash

# Deployment script for property replication service
# Usage: ./deploy.sh <server_ip> [ssh_key_path]

# Configuration
REPO_URL="https://github.com/aligeramy/realtor-db.git"
PROJECT_DIR="/opt/realtor-db"
APP_PORT=9630
NODE_VERSION="18.x"  # LTS version

# Check for required arguments
if [ -z "$1" ]; then
    echo "Error: Server IP is required"
    echo "Usage: ./deploy.sh <server_ip> [ssh_key_path]"
    exit 1
fi

SERVER_IP=$1
SSH_KEY=""

# Check if SSH key path is provided
if [ ! -z "$2" ]; then
    SSH_KEY="-i $2"
fi

echo "=== Deploying to VPS at $SERVER_IP ==="

# SSH commands to set up the environment and deploy
ssh $SSH_KEY root@$SERVER_IP << 'EOF'
    set -e  # Exit on error

    # Update system packages
    echo "=== Updating system packages ==="
    apt-get update
    apt-get upgrade -y

    # Install required dependencies
    echo "=== Installing dependencies ==="
    apt-get install -y git curl build-essential postgresql postgresql-contrib

    # Install Node.js if not already installed
    if ! command -v node &> /dev/null; then
        echo "=== Installing Node.js ==="
        curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
        apt-get install -y nodejs
    fi

    # Install PM2 globally
    echo "=== Installing PM2 ==="
    npm install -g pm2

    # Clone or update the repository
    echo "=== Cloning/updating repository ==="
    if [ -d "$PROJECT_DIR" ]; then
        cd $PROJECT_DIR
        git pull
    else
        git clone $REPO_URL $PROJECT_DIR
        cd $PROJECT_DIR
    fi

    # Install dependencies
    echo "=== Installing project dependencies ==="
    npm ci

    # Create .env file if it doesn't exist
    if [ ! -f ".env" ]; then
        echo "=== Creating .env file ==="
        cp .env.example .env
        # Set the port in .env
        echo "PORT=$APP_PORT" >> .env
        echo "Please update your .env file with the correct credentials"
    fi

    # Configure PostgreSQL (assumes database is on the same server)
    echo "=== Configuring PostgreSQL ==="
    sudo -u postgres psql -c "CREATE DATABASE listings WITH ENCODING='UTF8' LC_COLLATE='en_US.UTF-8' LC_CTYPE='en_US.UTF-8' TEMPLATE=template0;" || true
    sudo -u postgres psql -c "CREATE USER realtordb WITH ENCRYPTED PASSWORD 'strong_password_here';" || true
    sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE listings TO realtordb;" || true

    # Initialize database schema (if needed)
    echo "=== Running database migrations ==="
    if [ -f "db/schema.sql" ]; then
        sudo -u postgres psql -d listings -f db/schema.sql
    fi

    # Configure PM2
    echo "=== Configuring PM2 ==="
    # Update ecosystem.config.js with the correct port
    sed -i "s/PORT: '[0-9]*'/PORT: '$APP_PORT'/g" ecosystem.config.js
    
    # Start the application with PM2
    echo "=== Starting application with PM2 ==="
    pm2 delete realtor-db 2>/dev/null || true
    pm2 start ecosystem.config.js
    
    # Save PM2 configuration to restart on reboot
    pm2 save
    
    # Configure PM2 to start on system startup
    pm2 startup | tail -n 1 | bash

    echo ""
    echo "=== Deployment completed successfully ==="
    echo "The application is now running at http://$SERVER_IP:$APP_PORT"
    echo "Monitor logs with: pm2 logs"
    echo "View status with: pm2 status"
EOF

echo "=== Deployment script completed ==="
echo "Please SSH into your server and update the .env file with your database credentials and API keys" 