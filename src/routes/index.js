const express = require('express');
const TradeController = require('../controllers/tradeController');
const AutoSellController = require('../controllers/autoSellController');
const docsRouter = require('./docs');
// const AutoSellController = require('../controllers/autoSellController'); // To be created if needed

const router = express.Router();

// Trade endpoints
router.get('/trade/:txid', (req, res) => TradeController.getTrade(req, res));
router.post('/trades/batch', (req, res) => TradeController.getBatchTrades(req, res));

// Auto-sell status endpoint
router.get('/auto-sell/status', (req, res) => AutoSellController.getStatus(req, res));

// Mount docs (Swagger UI and OpenAPI JSON)
router.use(docsRouter);

// TODO: Add auto-sell status and other endpoints here

module.exports = router; 