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

// Auto-sell routes
router.get('/auto-sell/status', autoSellController.getStatus);
router.get('/auto-sell/balances', (req, res) => {
  sendSuccessResponse(res, {
    balances: autoSellService.getCurrentBalances()
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

module.exports = router; 