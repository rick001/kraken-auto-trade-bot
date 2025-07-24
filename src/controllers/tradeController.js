const krakenService = require('../services/krakenService');
const { formatTradeData } = require('../utils/helpers');
const { validateTxid, validateTxidArray, handleValidationError } = require('../utils/validation');
const { sendErrorResponse, sendSuccessResponse, createNotFoundError, createKrakenApiError, createInternalError } = require('../utils/errorHandler');
const logger = require('../utils/logger');

// Get details for a single trade/order by transaction ID
exports.getTrade = async (req, res) => {
  try {
    const txid = validateTxid(req.params.txid);
    
    // Fetch order status
    const orderResp = await krakenService.kraken.api('QueryOrders', { txid, trades: true });
    const order = orderResp.result[txid];
    if (!order) {
      const notFoundError = createNotFoundError('Order not found', { txid });
      return sendErrorResponse(res, notFoundError, {
        endpoint: req.path,
        method: req.method,
        userAgent: req.get('User-Agent'),
        ip: req.ip,
        params: req.params
      });
    }
    
    // Fetch trade details if available
    let trades = null;
    if (order.trades && order.trades.length > 0) {
      const tradesResp = await krakenService.kraken.api('QueryTrades', { txid: order.trades.join(',') });
      trades = tradesResp.result;
    }
    
    const tradeData = formatTradeData(order, trades, txid);
    sendSuccessResponse(res, tradeData);
  } catch (error) {
    if (error.type === 'Validation Error') {
      handleValidationError(error, req, res);
    } else if (error.message && error.message.includes('Kraken')) {
      const krakenError = createKrakenApiError('Failed to fetch trade details from Kraken API', error);
      sendErrorResponse(res, krakenError, {
        endpoint: req.path,
        method: req.method,
        userAgent: req.get('User-Agent'),
        ip: req.ip,
        params: req.params
      });
    } else {
      const internalError = createInternalError('Failed to fetch trade details', error.message);
      sendErrorResponse(res, internalError, {
        endpoint: req.path,
        method: req.method,
        userAgent: req.get('User-Agent'),
        ip: req.ip,
        params: req.params
      });
    }
  }
};

// Get details for multiple trades/orders by transaction IDs
exports.getBatchTrades = async (req, res) => {
  try {
    const txids = validateTxidArray(req.body.txids);
    
    const results = {};
    const errors = [];
    
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
          results[txid] = { 
            error: 'Order not found',
            message: `Order with txid ${txid} was not found`,
            timestamp: new Date().toISOString()
          };
          errors.push({ txid, error: 'Order not found' });
        }
      } catch (err) {
        results[txid] = { 
          error: 'Failed to fetch order',
          message: err.message,
          timestamp: new Date().toISOString()
        };
        errors.push({ txid, error: err.message });
      }
    }
    
    const response = {
      results,
      summary: {
        total: txids.length,
        successful: Object.keys(results).filter(txid => !results[txid].error).length,
        failed: errors.length,
        errors
      }
    };
    
    sendSuccessResponse(res, response);
  } catch (error) {
    if (error.type === 'Validation Error') {
      handleValidationError(error, req, res);
    } else if (error.message && error.message.includes('Kraken')) {
      const krakenError = createKrakenApiError('Failed to process batch request from Kraken API', error);
      sendErrorResponse(res, krakenError, {
        endpoint: req.path,
        method: req.method,
        userAgent: req.get('User-Agent'),
        ip: req.ip,
        body: req.body
      });
    } else {
      const internalError = createInternalError('Failed to process batch request', error.message);
      sendErrorResponse(res, internalError, {
        endpoint: req.path,
        method: req.method,
        userAgent: req.get('User-Agent'),
        ip: req.ip,
        body: req.body
      });
    }
  }
}; 