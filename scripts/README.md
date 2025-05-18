# AMPRE Replication Scripts

This directory contains utility scripts for the AMPRE property data replication system.

## Available Scripts

### `test-connectivity.js`
Tests connectivity to both the database and AMPRE API.

```bash
node scripts/test-connectivity.js
```

### `run-replication-service.sh`
A shell script to run the main application as a service using PM2 for process management.

```bash
# Make the script executable first
chmod +x scripts/run-replication-service.sh

# Then run it
./scripts/run-replication-service.sh
```

This script will:
1. Start the main application (index.js)
2. Set up PM2 to keep it running in the background
3. Configure PM2 to restart the service if it crashes
4. Set up PM2 to restart the service if the server reboots

The main application (index.js) handles both:
- Initial replication to fetch all property data
- Scheduled updates every 5 minutes to keep the data current

You can view logs with:
```bash
pm2 logs ampre-replication-service
``` 