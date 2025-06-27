const axios = require('axios');
const config = require('../config');
const logger = require('./logger');

// Retry utility with exponential backoff
async function withRetry(operation, operationName, maxAttempts = config.kraken.retryAttempts) {
  let lastError;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const isLastAttempt = attempt === maxAttempts;
      
      if (isLastAttempt || !isRetryableError(error)) {
        throw error;
      }
      
      logger.warn(`${operationName} failed, retrying...`, {
        attempt,
        maxAttempts,
        error: error.message
      });
      
      await new Promise(resolve => setTimeout(resolve, config.kraken.retryDelay * attempt));
    }
  }
  
  throw lastError;
}

// Check if an error is retryable
function isRetryableError(error) {
  return (
    error.code === 'ECONNRESET' ||
    error.code === 'ETIMEDOUT' ||
    error.code === 'ECONNREFUSED' ||
    (error.response && error.response.status >= 500) ||
    error.message.includes('Invalid nonce') ||
    error.message.includes('API:Invalid nonce')
  );
}

// Rate limiter utility
class RateLimiter {
  constructor() {
    this.requests = [];
  }

  async waitForSlot() {
    const now = Date.now();
    this.requests = this.requests.filter(time => now - time < config.kraken.rateLimit.period);
    
    if (this.requests.length >= config.kraken.rateLimit.maxRequests) {
      const oldestRequest = this.requests[0];
      const waitTime = config.kraken.rateLimit.period - (now - oldestRequest);
      if (waitTime > 0) {
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
    
    this.requests.push(now);
  }
}

// API logging utility
async function sendLogToApi(logData) {
  if (!config.logging.api.enabled || !config.logging.api.endpoint) {
    logger.debug('API logging disabled or endpoint not configured');
    return;
  }
  
  try {
    const headers = {
      'Content-Type': 'application/json'
    };
    
    if (config.logging.api.apiKey) {
      headers['x-secret-key'] = config.logging.api.apiKey;
    }
    
    await axios.post(config.logging.api.endpoint, logData, {
      headers,
      timeout: config.kraken.timeout
    });
  } catch (error) {
    logger.error('Failed to send log to API', {
      error: error.message,
      status: error.response?.status,
      data: error.response?.data
    });
    throw error;
  }
}

// Asset name conversion utility
function convertAssetName(asset) {
  const conversions = {
    'XETH': 'ETH',
    'XXBT': 'BTC',
    'XXDG': 'DOGE',
    'ZUSD': 'USD',
    'ZUSDT': 'USDT',
    'ZUSDC': 'USDC'
  };
  
  return conversions[asset] || asset;
}

// Format trade data utility
function formatTradeData(order, trades, txid = null) {
  if (!order) {
    logger.warn('formatTradeData: order is null or undefined');
    return null;
  }
  
  const orderData = {
    orderId: txid || order.txid || 'unknown',
    status: order.status || 'unknown',
    description: order.descr?.order || 'No description',
    volume: parseFloat(order.vol) || 0,
    price: parseFloat(order.price) || 0,
    cost: parseFloat(order.cost) || 0,
    fee: parseFloat(order.fee) || 0,
    timestamp: order.opentm ? new Date(order.opentm * 1000).toISOString() : new Date().toISOString(),
    closeTime: order.closetm ? new Date(order.closetm * 1000).toISOString() : null,
    trades: []
  };

  if (!order.txid && !txid) {
    logger.warn('formatTradeData: order.txid is missing and no txid parameter provided', {
      orderKeys: Object.keys(order),
      orderId: orderData.orderId
    });
  }

  if (trades) {
    orderData.trades = Object.entries(trades).map(([tradeTxid, trade]) => ({
      tradeId: tradeTxid,
      pair: trade.pair,
      type: trade.type,
      ordertype: trade.ordertype,
      price: parseFloat(trade.price) || 0,
      cost: parseFloat(trade.cost) || 0,
      fee: parseFloat(trade.fee) || 0,
      volume: parseFloat(trade.vol) || 0,
      margin: trade.margin,
      timestamp: new Date(trade.time * 1000).toISOString(),
      misc: trade.misc
    }));
  }

  return orderData;
}

module.exports = {
  withRetry,
  isRetryableError,
  RateLimiter,
  sendLogToApi,
  convertAssetName,
  formatTradeData
}; 