# Property Listings Replication Service

A high-performance property listings replication service that synchronizes data from AMPRE API to a PostgreSQL database.

## Features

- Sequential replication of properties and media
- Optimized API client with rate limiting and exponential backoff
- RESTful API for querying property data
- Support for full, incremental, and media-only replication modes

## Tech Stack

- Node.js
- Express
- PostgreSQL
- Drizzle ORM
- PM2 for process management

## Installation

1. Clone the repository:
```bash
git clone https://github.com/yourusername/property-replication.git
cd property-replication
```

2. Install dependencies:
```bash
npm install
```

3. Set up environment variables in `.env`:
```
# Database
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=listings
POSTGRES_USER=your_user
POSTGRES_PASSWORD=your_password

# API
AMPERE_API_KEY=your_api_key

# Replication
REPLICATION_BATCH_SIZE=5000
REPLICATION_CONCURRENCY=50
SYNC_INTERVAL_MINUTES=5
```

4. Set up the database schema:
```bash
npm run drizzle:generate
npm run drizzle:push
```

## Database Management

### Drizzle Studio

To view and manage your database using Drizzle Studio:

```bash
npm run drizzle:studio
```

### Database Migrations

Generate migrations from schema changes:
```bash
npm run drizzle:generate
```

Apply migrations to the database:
```bash
npm run drizzle:push
```

## Running the Service

### Development

```bash
npm run dev
```

### Production

```bash
npm start
```

Or using PM2:

```bash
pm2 start ecosystem.config.js --env production
```

## API Endpoints

- `GET /api/status` - Service status and statistics
- `POST /api/replicate` - Trigger manual replication
- `GET /api/listings/:id` - Get a specific listing
- `GET /api/listings` - Search listings with filters
- `GET /api/analytics/summary` - Get property analytics

## Deployment

Use the included deployment script:

```bash
chmod +x deploy.sh
./deploy.sh
```

## License

MIT 