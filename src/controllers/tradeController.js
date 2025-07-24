const krakenService = require('../services/krakenService');
const { formatTradeData } = require('../utils/helpers');
const { validateTxid, validateTxidArray, handleValidationError } = require('../utils/validation');
const logger = require('../utils/logger');

// Get details for a single trade/order by transaction ID
exports.getTrade = async (req, res) => {
  try {
    const txid = validateTxid(req.params.txid);
    
    // Fetch order status
    const orderResp = await krakenService.kraken.api('QueryOrders', { txid, trades: true });
    const order = orderResp.result[txid];
    if (!order) {
      return res.status(404).json({ error: 'Order not found', txid });
    }
    // Fetch trade details if available
    let trades = null;
    if (order.trades && order.trades.length > 0) {
      const tradesResp = await krakenService.kraken.api('QueryTrades', { txid: order.trades.join(',') });
      trades = tradesResp.result;
    }
    const tradeData = formatTradeData(order, trades, txid);
    res.json(tradeData);
  } catch (error) {
    if (error.message.includes('Transaction ID') || error.message.includes('Invalid')) {
      handleValidationError(error, req, res);
    } else {
      logger.error('Error in getTrade:', error);
      res.status(500).json({ error: 'Failed to fetch trade details', message: error.message });
    }
  }
};

// Get details for multiple trades/orders by transaction IDs
exports.getBatchTrades = async (req, res) => {
  try {
    const txids = validateTxidArray(req.body.txids);
    
    const results = {};
    for (const txid of txids) {
      try {
        const orderResp = await krakenService.kraken.api('QueryOrders', { txid, trades: true });
        const order = orderResp.result[txid];
        if (order) {
          let trades = null;
          if (order.trades && order.trades.length > 0) {
            const tradesResp = await krakenService.kraken.api('QueryTrades', { txid: order.trades.join(',') });
            trades = tradesResp.result;
          }
          results[txid] = formatTradeData(order, trades, txid);
        } else {
          results[txid] = { error: 'Order not found' };
        }
      } catch (err) {
        results[txid] = { error: err.message };
      }
    }
    res.json(results);
  } catch (error) {
    if (error.message.includes('Transaction ID') || error.message.includes('Invalid') || error.message.includes('array')) {
      handleValidationError(error, req, res);
    } else {
      logger.error('Error in getBatchTrades:', error);
      res.status(500).json({ error: 'Failed to process batch request', message: error.message });
    }
  }
}; 