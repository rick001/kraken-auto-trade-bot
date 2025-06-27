const krakenService = require('../services/krakenService');
const { formatTradeData } = require('../utils/helpers');

// Get details for a single trade/order by transaction ID
exports.getTrade = async (req, res) => {
  try {
    const { txid } = req.params;
    if (!txid) {
      return res.status(400).json({ error: 'Missing txid parameter' });
    }
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
    res.status(500).json({ error: 'Failed to fetch trade details', message: error.message });
  }
};

// Get details for multiple trades/orders by transaction IDs
exports.getBatchTrades = async (req, res) => {
  try {
    const { txids } = req.body;
    if (!Array.isArray(txids) || txids.length === 0) {
      return res.status(400).json({ error: 'Invalid request', message: 'txids must be a non-empty array' });
    }
    if (txids.length > 20) {
      return res.status(400).json({ error: 'Invalid request', message: 'Maximum 20 txids per request' });
    }
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
    res.status(500).json({ error: 'Failed to process batch request', message: error.message });
  }
}; 