const express = require('express');
const router = express.Router();
const tradeController = require('../controllers/tradeController');
const autoSellController = require('../controllers/autoSellController');
const autoSellService = require('../services/autoSellService');
const krakenService = require('../services/krakenService');
const logger = require('../utils/logger');
const { validateAsset, handleValidationError } = require('../utils/validation');
const docsRouter = require('./docs');

// Health check
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Debug endpoint to check BTC balance
router.get('/debug/balance/:asset', async (req, res) => {
  try {
    const asset = validateAsset(req.params.asset);
    const balanceInfo = await krakenService.checkBalanceForAsset(asset);
    res.json({
      asset,
      balanceInfo,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    if (error.message.includes('Asset parameter') || error.message.includes('Invalid')) {
      handleValidationError(error, req, res);
    } else {
      logger.error('Error in debug balance endpoint:', error);
      res.status(500).json({ error: error.message });
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
    
    res.json({
      asset,
      hasMarketPair,
      marketPair,
      availablePairs: assetPairs,
      totalPairs: pairs.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    if (error.message.includes('Asset parameter') || error.message.includes('Invalid')) {
      handleValidationError(error, req, res);
    } else {
      logger.error('Error in debug pairs endpoint:', error);
      res.status(500).json({ error: error.message });
    }
  }
});

// Debug endpoint to check rate limiter status
router.get('/debug/rate-limiter', (req, res) => {
  try {
    const rateLimiterStatus = krakenService.rateLimiter.getStatus();
    res.json({
      rateLimiter: rateLimiterStatus,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error in debug rate limiter endpoint:', error);
    res.status(500).json({ error: error.message });
  }
});

// Trade routes
router.get('/trades/:txid', tradeController.getTrade);
router.post('/trades/batch', tradeController.getBatchTrades);

// Auto-sell routes
router.get('/auto-sell/status', autoSellController.getStatus);
router.get('/auto-sell/balances', (req, res) => {
  res.json({
    balances: autoSellService.getCurrentBalances(),
    timestamp: new Date().toISOString()
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
      return res.status(404).json({
        error: 'Asset not found',
        asset: asset,
        availableAssets: Object.keys(currentBalances),
        timestamp: new Date().toISOString()
      });
    }
    
    const balance = currentBalances[assetKey];
    const balanceValue = parseFloat(balance) || 0;
    
    res.json({
      asset: assetKey,
      balance: balance,
      balanceValue: balanceValue,
      hasBalance: balanceValue > 0,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    if (error.message.includes('Asset parameter') || error.message.includes('Invalid')) {
      handleValidationError(error, req, res);
    } else {
      logger.error('Error in balance endpoint:', error);
      res.status(500).json({ error: error.message });
    }
  }
});

// API documentation
router.use('/docs', docsRouter);

module.exports = router; 