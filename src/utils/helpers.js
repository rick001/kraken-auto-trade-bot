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
    this.maxArraySize = 1000; // Prevent unbounded growth
    this.lastCleanup = Date.now();
    this.cleanupInterval = 60000; // Cleanup every minute
  }

  async waitForSlot() {
    const now = Date.now();
    
    // Periodic cleanup to prevent memory leaks
    if (now - this.lastCleanup > this.cleanupInterval) {
      this._cleanup();
      this.lastCleanup = now;
    }
    
    // Remove old timestamps efficiently
    const cutoffTime = now - config.kraken.rateLimit.period;
    let removedCount = 0;
    
    // Efficiently remove old entries from the beginning
    while (this.requests.length > 0 && this.requests[0] < cutoffTime) {
      this.requests.shift();
      removedCount++;
    }
    
    // Log cleanup if significant
    if (removedCount > 0) {
      logger.debug(`RateLimiter cleanup: removed ${removedCount} old timestamps`, {
        remainingCount: this.requests.length,
        cutoffTime: new Date(cutoffTime).toISOString()
      });
    }
    
    // Check if we need to wait
    if (this.requests.length >= config.kraken.rateLimit.maxRequests) {
      const oldestRequest = this.requests[0];
      const waitTime = config.kraken.rateLimit.period - (now - oldestRequest);
      
      if (waitTime > 0) {
        logger.debug(`Rate limit reached, waiting ${waitTime}ms`, {
          currentRequests: this.requests.length,
          maxRequests: config.kraken.rateLimit.maxRequests,
          oldestRequest: new Date(oldestRequest).toISOString()
        });
        
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
    
    // Add current request timestamp
    this.requests.push(now);
    
    // Emergency cleanup if array gets too large
    if (this.requests.length > this.maxArraySize) {
      logger.warn(`RateLimiter array size exceeded limit, performing emergency cleanup`, {
        currentSize: this.requests.length,
        maxSize: this.maxArraySize,
        oldestTimestamp: new Date(this.requests[0]).toISOString(),
        newestTimestamp: new Date(this.requests[this.requests.length - 1]).toISOString()
      });
      
      // Keep only the most recent entries
      const keepCount = Math.floor(this.maxArraySize * 0.8); // Keep 80% of max size
      this.requests = this.requests.slice(-keepCount);
      
      logger.info(`RateLimiter emergency cleanup completed`, {
        newSize: this.requests.length,
        removedCount: this.maxArraySize - this.requests.length
      });
    }
  }

  // Internal cleanup method
  _cleanup() {
    const now = Date.now();
    const cutoffTime = now - config.kraken.rateLimit.period;
    const originalSize = this.requests.length;
    
    // Remove all timestamps older than the rate limit period
    this.requests = this.requests.filter(time => time >= cutoffTime);
    
    const removedCount = originalSize - this.requests.length;
    
    if (removedCount > 0) {
      logger.debug(`RateLimiter periodic cleanup: removed ${removedCount} old timestamps`, {
        originalSize,
        newSize: this.requests.length,
        cutoffTime: new Date(cutoffTime).toISOString()
      });
    }
  }

  // Get current rate limiter status (for debugging)
  getStatus() {
    const now = Date.now();
    const cutoffTime = now - config.kraken.rateLimit.period;
    const activeRequests = this.requests.filter(time => time >= cutoffTime).length;
    
    return {
      totalRequests: this.requests.length,
      activeRequests,
      maxRequests: config.kraken.rateLimit.maxRequests,
      period: config.kraken.rateLimit.period,
      lastCleanup: new Date(this.lastCleanup).toISOString(),
      isRateLimited: activeRequests >= config.kraken.rateLimit.maxRequests
    };
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