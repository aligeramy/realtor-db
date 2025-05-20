module.exports = {
  apps: [
    {
      name: 'property-replicator',
      script: 'index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      args: "--mode full",
      env: {
        NODE_ENV: 'production',
        REPLICATION_BATCH_SIZE: '5000',
        REPLICATION_CONCURRENCY: '50',
        SYNC_INTERVAL_MINUTES: '15',
        RUN_ADDRESS_STANDARDIZATION: 'true',
        ADDRESS_BATCH_SIZE: '500'
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