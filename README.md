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
git clone https://github.com/aligeramy/realtor-db.git
cd realtor-db
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

## RUN
```bash
caffeinate -i node scripts/standardize-addresses.js
```

## Deployment Guide

### Prerequisites

- Ubuntu 20.04 or newer
- Node.js 16+ 
- PostgreSQL 12+ with PostGIS extension
- PM2 for process management

### Deployment Steps

1. **Clone the repository to your server**:
   ```bash
   git clone https://github.com/aligeramy/realtor-db.git /opt/realtor-db
   cd /opt/realtor-db
   ```

2. **Set up environment variables**:
   ```bash
   cp .env.example .env
   # Edit .env with your production values
   nano .env
   ```

3. **Install dependencies**:
   ```bash
   npm install
   ```

4. **Apply database migrations**:
   ```bash
   npm run db:setup
   ```
   This will create the database schema and apply all migrations, including setting up PostGIS extensions and spatial indexes needed for search functionality.

5. **Start the application with PM2**:
   ```bash
   pm2 start ecosystem.config.js --env production
   pm2 save
   ```

6. **Configure PM2 to start on system boot**:
   ```bash
   pm2 startup
   # Then run the command it outputs
   ```

7. **Set up Nginx as a reverse proxy** (optional but recommended):
   ```bash
   sudo apt install -y nginx
   sudo nano /etc/nginx/sites-available/property-api
   ```

   Add the following configuration:
   ```
   server {
       listen 80;
       server_name api.yourdomain.com;

       location / {
           proxy_pass http://localhost:9696;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection 'upgrade';
           proxy_set_header Host $host;
           proxy_cache_bypass $http_upgrade;
       }
   }
   ```

   Enable the configuration:
   ```bash
   sudo ln -s /etc/nginx/sites-available/property-api /etc/nginx/sites-enabled/
   sudo nginx -t
   sudo systemctl restart nginx
   ```

8. **Set up SSL with Let's Encrypt** (recommended):
   ```bash
   sudo apt install -y certbot python3-certbot-nginx
   sudo certbot --nginx -d api.yourdomain.com
   ```

9. **Verify the deployment**:
   ```bash
   curl http://localhost:9696/health
   curl http://api.yourdomain.com/health  # If using a domain
   ```

### Monitoring and Maintenance

- **View logs**:
  ```bash
  pm2 logs property-replicator
  pm2 logs property-api
  ```

- **Restart services**:
  ```bash
  pm2 restart property-replicator
  pm2 restart property-api
  ```

- **Update the application**:
  ```bash
  cd /opt/realtor-db
  git pull
  npm install
  pm2 restart all
  ```
