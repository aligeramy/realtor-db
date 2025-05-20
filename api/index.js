import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { logger } from '../utils/logger.js';
import searchRoutes from './search-routes.js';

// Load environment variables
dotenv.config();

// Create Express app
const app = express();
const PORT = process.env.API_PORT || 9696;

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api', searchRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server
app.listen(PORT, () => {
  logger.info(`Property API server running on port ${PORT}`);
});

export default app; 