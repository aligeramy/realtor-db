module.exports = {
  apps: [
    {
      name: 'realtor-db',
      script: 'index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'development',
        PORT: '9630',
        REPLICATION_BATCH_SIZE: '5000',
        REPLICATION_CONCURRENCY: '50',
        SYNC_INTERVAL_MINUTES: '30'
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: '9630',
        REPLICATION_BATCH_SIZE: '5000',
        REPLICATION_CONCURRENCY: '50',
        SYNC_INTERVAL_MINUTES: '30',
        RUN_ADDRESS_STANDARDIZATION: 'true',
        ENABLE_GEOCODING: 'true',
        ADDRESS_BATCH_SIZE: '1000',
        GEOCODING_CONCURRENCY: '10'
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true
    },
    {
      name: 'property-api',
      script: 'api/index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        API_PORT: '9696'
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true
    }
  ]
}; 