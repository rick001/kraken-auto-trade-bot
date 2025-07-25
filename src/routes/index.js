const express = require('express');
const router = express.Router();
const tradeController = require('../controllers/tradeController');
const autoSellController = require('../controllers/autoSellController');
const autoSellService = require('../services/autoSellService');
const krakenService = require('../services/krakenService');
const logger = require('../utils/logger');
const { validateAsset, handleValidationError } = require('../utils/validation');
const { sendErrorResponse, sendSuccessResponse, createNotFoundError, createInternalError } = require('../utils/errorHandler');
const docsRouter = require('./docs');

// Health check
router.get('/health', (req, res) => {
  sendSuccessResponse(res, {
    status: 'ok',
    uptime: process.uptime()
  });
});

// Root API endpoint - provide overview
router.get('/', (req, res) => {
  sendSuccessResponse(res, {
    message: 'Kraken Auto-Trade Bot API',
    version: '1.0.0',
    description: 'Unified API for Kraken auto-sell service and trade details',
    availableEndpoints: [
      {
        path: '/api/health',
        method: 'GET',
        description: 'Health check endpoint'
      },
      {
        path: '/api/trades/{txid}',
        method: 'GET',
        description: 'Get trade details by transaction ID'
      },
      {
        path: '/api/trades/batch',
        method: 'POST',
        description: 'Get multiple trade details'
      },
      {
        path: '/api/auto-sell/status',
        method: 'GET',
        description: 'Get auto-sell service status'
      },
      {
        path: '/api/auto-sell/balances',
        method: 'GET',
        description: 'Get current balances'
      },
      {
        path: '/api/balance/{asset}',
        method: 'GET',
        description: 'Get balance for specific asset'
      },
      {
        path: '/api/docs',
        method: 'GET',
        description: 'Interactive API documentation'
      }
    ],
    documentation: '/api/docs'
  });
});

// Debug endpoint to check BTC balance
router.get('/debug/balance/:asset', async (req, res) => {
  try {
    const asset = validateAsset(req.params.asset);
    const balanceInfo = await krakenService.checkBalanceForAsset(asset);
    sendSuccessResponse(res, {
      asset,
      balanceInfo
    });
  } catch (error) {
    if (error.type === 'Validation Error') {
      handleValidationError(error, req, res);
    } else {
      const internalError = createInternalError('Failed to check balance for asset', error.message);
      sendErrorResponse(res, internalError, {
        endpoint: req.path,
        method: req.method,
        userAgent: req.get('User-Agent'),
        ip: req.ip,
        params: req.params
      });
    }
  }
});

// Debug endpoint to check available pairs for an asset
router.get('/debug/pairs/:asset', async (req, res) => {
  try {
    const asset = validateAsset(req.params.asset);
    const pairs = krakenService.getTradablePairs();
    const assetPairs = pairs.filter(p => p.includes(asset));
    const hasMarketPair = krakenService.hasMarketPair(asset);
    const marketPair = krakenService.getMarketPair(asset);
    
    sendSuccessResponse(res, {
      asset,
      hasMarketPair,
      marketPair,
      availablePairs: assetPairs,
      totalPairs: pairs.length
    });
  } catch (error) {
    if (error.type === 'Validation Error') {
      handleValidationError(error, req, res);
    } else {
      const internalError = createInternalError('Failed to check pairs for asset', error.message);
      sendErrorResponse(res, internalError, {
        endpoint: req.path,
        method: req.method,
        userAgent: req.get('User-Agent'),
        ip: req.ip,
        params: req.params
      });
    }
  }
});

// Debug endpoint to check rate limiter status
router.get('/debug/rate-limiter', (req, res) => {
  try {
    const rateLimiterStatus = krakenService.rateLimiter.getStatus();
    sendSuccessResponse(res, {
      rateLimiter: rateLimiterStatus
    });
  } catch (error) {
    const internalError = createInternalError('Failed to get rate limiter status', error.message);
    sendErrorResponse(res, internalError, {
      endpoint: req.path,
      method: req.method,
      userAgent: req.get('User-Agent'),
      ip: req.ip
    });
  }
});

// Trade routes
router.get('/trades/:txid', tradeController.getTrade);
router.post('/trades/batch', tradeController.getBatchTrades);

// Handle trades endpoint with trailing slash
router.get('/trades/', (req, res) => {
  sendSuccessResponse(res, {
    message: 'Trade endpoints',
    availableEndpoints: [
      {
        path: '/api/trades/{txid}',
        method: 'GET',
        description: 'Get details for a specific trade by transaction ID'
      },
      {
        path: '/api/trades/batch',
        method: 'POST',
        description: 'Get details for multiple trades by transaction IDs'
      }
    ]
  });
});

// Auto-sell routes
router.get('/auto-sell/status', autoSellController.getStatus);
router.get('/auto-sell/balances', (req, res) => {
  sendSuccessResponse(res, {
    balances: autoSellService.getCurrentBalances()
  });
});

// Handle auto-sell endpoint with trailing slash
router.get('/auto-sell/', (req, res) => {
  sendSuccessResponse(res, {
    message: 'Auto-sell service endpoints',
    availableEndpoints: [
      {
        path: '/api/auto-sell/status',
        method: 'GET',
        description: 'Get auto-sell service status and current balances'
      },
      {
        path: '/api/auto-sell/balances',
        method: 'GET',
        description: 'Get current account balances'
      }
    ],
    currentStatus: {
      running: true,
      initialProcessingComplete: autoSellService.isInitialProcessingComplete(),
      websocketConnected: require('../services/websocketService').isConnected()
    }
  });
});

// Get current balance for a specific asset
router.get('/balance/:asset', async (req, res) => {
  try {
    const asset = validateAsset(req.params.asset);
    const currentBalances = autoSellService.getCurrentBalances();
    
    // Try to find the asset in current balances (case-insensitive)
    const assetKey = Object.keys(currentBalances).find(
      key => key.toUpperCase() === asset.toUpperCase()
    );
    
    if (!assetKey) {
      const notFoundError = createNotFoundError('Asset not found', { 
        asset, 
        availableAssets: Object.keys(currentBalances) 
      });
      return sendErrorResponse(res, notFoundError, {
        endpoint: req.path,
        method: req.method,
        userAgent: req.get('User-Agent'),
        ip: req.ip,
        params: req.params
      });
    }
    
    const balance = currentBalances[assetKey];
    const balanceValue = parseFloat(balance) || 0;
    
    sendSuccessResponse(res, {
      asset: assetKey,
      balance: balance,
      balanceValue: balanceValue,
      hasBalance: balanceValue > 0
    });
  } catch (error) {
    if (error.type === 'Validation Error') {
      handleValidationError(error, req, res);
    } else {
      const internalError = createInternalError('Failed to get balance for asset', error.message);
      sendErrorResponse(res, internalError, {
        endpoint: req.path,
        method: req.method,
        userAgent: req.get('User-Agent'),
        ip: req.ip,
        params: req.params
      });
    }
  }
});

// API documentation
router.use('/docs', docsRouter);

// Redirect /docs/ to /docs (handle trailing slash)
router.get('/docs/', (req, res) => {
  res.redirect('/api/docs');
});

module.exports = router; 