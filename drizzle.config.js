import dotenv from 'dotenv';
dotenv.config();

export default {
  schema: './db/schema.drizzle.js',
  out: './drizzle/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    host: process.env.POSTGRES_HOST || '198.251.68.5',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    database: process.env.POSTGRES_DB || 'listings',
    user: process.env.POSTGRES_USER || 'pooya',
    password: process.env.POSTGRES_PASSWORD || 'hR72fW9nTqZxB3dMvgKpY1CsJeULoXNb',
    ssl: false
  },
  verbose: true,
  strict: true,
}; 