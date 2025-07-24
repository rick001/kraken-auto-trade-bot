const express = require('express');
const cors = require('cors');
const config = require('./config');
const logger = require('./utils/logger');
const { sendErrorResponse, createNotFoundError, createInternalError } = require('./utils/errorHandler');
const apiRouter = require('./routes');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// API routes
app.use('/api', apiRouter);

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: config.server.environment,
    kraken: {
      sandbox: config.kraken.sandbox,
      endpoints: config.kraken.endpoints
    }
  });
});

// 404 handler
app.use((req, res) => {
  const notFoundError = createNotFoundError('Endpoint not found', { 
    path: req.path, 
    method: req.method 
  });
  sendErrorResponse(res, notFoundError, {
    endpoint: req.path,
    method: req.method,
    userAgent: req.get('User-Agent'),
    ip: req.ip
  });
});

// Error handler
app.use((err, req, res, next) => {
  const internalError = createInternalError('Unhandled server error', err.message);
  sendErrorResponse(res, internalError, {
    endpoint: req.path,
    method: req.method,
    userAgent: req.get('User-Agent'),
    ip: req.ip,
    stack: err.stack
  });
});

// Start server and background services
if (require.main === module) {
  app.listen(config.server.port);
  // Start background services
  const startServices = require('./startup');
  startServices().catch(err => {
    logger.error('Failed to start services', { error: err.message, stack: err.stack });
    process.exit(1);
  });
}

module.exports = app; 