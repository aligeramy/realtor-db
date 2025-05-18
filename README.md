# Property Listings Replicator

An Express application that replicates property listings from the AMPRE API to a PostgreSQL database and keeps them updated with incremental replication every 10 minutes.

## Features

- Full database replication from AMPRE API
- Dynamic schema discovery from API metadata
- Automatic database schema updates
- Replication state tracking with checkpoints for reliability
- Scheduled updates every 10 minutes
- REST API for listing search and retrieval
- Rate limiting protection with automatic retries
- Comprehensive error handling and logging

## Prerequisites

- Node.js 18+ 
- PostgreSQL database
- AMPRE API key

## Installation

1. Clone the repository to your VPS:

```bash
git clone https://github.com/yourusername/property-listings-replicator.git
cd property-listings-replicator
```

2. Install dependencies:

```bash
npm install
```

3. Environment variables:

The application uses the following environment variables from your `.env` file:

- `POSTGRES_URL`: PostgreSQL connection string
- `AMPERE_API_KEY`: Your AMPRE API key
- `PORT`: (Optional) Port to run the Express server (defaults to 3000)

4. Start the application:

```bash
# For development with auto-reload
npm run dev

# For production
npm start
```

## Process Flow

1. On startup, the application:
   - Initializes the database schema
   - Discovers the API schema and updates the database with any additional columns
   - Starts the Express server
   - Schedules the initial replication after 1 minute
   - Sets up a cron job for incremental replication every 10 minutes

2. During replication:
   - The application retrieves batches of properties using timestamp-based replication
   - It processes each property, extracting relevant data and media keys
   - It inserts or updates records in the database
   - It updates the replication state after each batch

## API Endpoints

### Status
- `GET /api/status`: Get replication status and database statistics

### Replication
- `POST /api/replicate`: Manually trigger replication
- `POST /api/discover-schema`: Discover and update schema

### Listings
- `GET /api/listings`: Search listings with filtering options
  - Parameters: `city`, `property_type`, `min_price`, `max_price`, `min_bedrooms`, `limit`, `offset`
- `GET /api/listings/:id`: Get a specific listing by ID

## Deployment

For production deployment:

1. Install PM2 for process management:

```bash
npm install -g pm2
```

2. Start the application:

```bash
pm2 start index.js --name="property-listings-replicator"
```

3. Configure PM2 to start on system boot:

```bash
pm2 startup
pm2 save
```

## Monitoring

You can monitor the application using:

```bash
pm2 logs property-listings-replicator
```

Or check the log files in the `logs` directory.

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Database Replication

This system replicates property listings data from the AMPRE API to a PostgreSQL database. The replication process has been significantly optimized to handle both initial setup and continuous updates efficiently.

### Replication Features

- **Two-Phase Approach**: First loads all properties, then processes media, to avoid foreign key constraint issues
- **Optimized Performance**: Uses large batch sizes (5000) and high concurrency (50) for fast processing 
- **Checkpoint System**: Properly tracks progress to resume from where it left off
- **Media Change Detection**: Special handling for media changes, which don't update the main ModificationTimestamp
- **Continuous Updates**: Built-in 5-minute update interval with smart mode selection

### Running Replication

There are several ways to run the replication process:

1. **Continuous Mode (Default)**:
   ```
   node scripts/run-optimized-replication.js
   ```
   This will run continuous replication with 5-minute intervals between updates.

2. **One-Time Run**:
   ```
   node scripts/run-optimized-replication.js --once
   ```
   This will run a single replication cycle and exit.

3. **Specific Mode**:
   ```
   node scripts/run-optimized-replication.js --mode full
   node scripts/run-optimized-replication.js --mode incremental
   node scripts/run-optimized-replication.js --mode media-only
   ```

4. **Via PM2**:
   The system is configured to run as a background service using PM2. Simply use:
   ```
   pm2 start ecosystem.config.js
   ```

### Replication Modes

- **Full**: Complete replication of all properties and their media
- **Incremental**: Updates only properties modified since the last sync (default)
- **Media-Only**: Updates only media for properties with media changes (using special timestamps)

### Configuration

Configure replication by setting these environment variables:

```
REPLICATION_BATCH_SIZE=5000     # Number of records per batch
REPLICATION_CONCURRENCY=50      # Number of parallel operations 
SYNC_INTERVAL_MINUTES=5         # Minutes between update cycles
``` 