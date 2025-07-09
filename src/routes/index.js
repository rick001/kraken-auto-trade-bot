const express = require('express');
const router = express.Router();
const tradeController = require('../controllers/tradeController');
const autoSellController = require('../controllers/autoSellController');
const krakenService = require('../services/krakenService');
const logger = require('../utils/logger');
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
    const { asset } = req.params;
    const balanceInfo = await krakenService.checkBalanceForAsset(asset);
    res.json({
      asset,
      balanceInfo,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error in debug balance endpoint:', error);
    res.status(500).json({ error: error.message });
  }
});

// Debug endpoint to check available pairs for an asset
router.get('/debug/pairs/:asset', async (req, res) => {
  try {
    const { asset } = req.params;
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
    logger.error('Error in debug pairs endpoint:', error);
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
    balances: autoSellController.getCurrentBalances(),
    timestamp: new Date().toISOString()
  });
});

// API Documentation routes
router.use('/', docsRouter);

module.exports = router; 