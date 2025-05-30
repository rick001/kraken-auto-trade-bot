require('dotenv').config();
const KrakenClient = require('kraken-api');
const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const qs = require('querystring');

// Constants and Configuration
const CONFIG = {
  API: {
    RETRY_ATTEMPTS: 3,
    RETRY_DELAY: 1000, // ms
    REQUEST_TIMEOUT: 10000, // ms
    RATE_LIMIT: {
      MAX_REQUESTS: 15,
      PERIOD: 1000 // ms
    },
    SANDBOX: process.env.KRAKEN_SANDBOX === 'true',
    ENDPOINTS: {
      REST: process.env.KRAKEN_SANDBOX === 'true' 
        ? 'https://demo-futures.kraken.com/derivatives/api/v3' 
        : 'https://api.kraken.com/0',
      WS: process.env.KRAKEN_SANDBOX === 'true'
        ? 'wss://demo-futures.kraken.com/ws/v1'
        : 'wss://ws-auth.kraken.com'
    }
  },
  WEBSOCKET: {
    RECONNECT_DELAY: 5000, // ms
    PING_INTERVAL: 30000, // ms
    PONG_TIMEOUT: 10000 // ms
  },
  LOGGING: {
    LEVELS: {
      ERROR: 'error',
      WARN: 'warn',
      INFO: 'info',
      DEBUG: 'debug'
    }
  }
};

const apiKey = process.env.KRAKEN_API_KEY;
const apiSecret = process.env.KRAKEN_API_SECRET;
const FIAT = process.env.TARGET_FIAT || 'ZUSD';

const kraken = new KrakenClient(apiKey, apiSecret, {
  timeout: CONFIG.API.REQUEST_TIMEOUT,
  sandbox: CONFIG.API.SANDBOX,
  baseUrl: CONFIG.API.ENDPOINTS.REST,
  version: CONFIG.API.SANDBOX ? 'v3' : '0'
});

// State management
let currentBalances = {};
let pairs = {};
let minimumOrderSizes = {};
let initialProcessingComplete = false;
let isProcessingSnapshot = false;
let requestCount = 0;
let lastRequestTime = Date.now();
let wsInstance = null;

// Rate limiting
const rateLimiter = {
  requests: [],
  async waitForSlot() {
    const now = Date.now();
    this.requests = this.requests.filter(time => now - time < CONFIG.API.RATE_LIMIT.PERIOD);
    if (this.requests.length >= CONFIG.API.RATE_LIMIT.MAX_REQUESTS) {
      const oldestRequest = this.requests[0];
      const waitTime = CONFIG.API.RATE_LIMIT.PERIOD - (now - oldestRequest);
      if (waitTime > 0) {
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
    this.requests.push(now);
  }
};

// Logging utility
const logger = {
  log(level, message, data = {}) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...(Object.keys(data).length > 0 ? data : {})
    };
    const consoleMessage = `[${logEntry.timestamp}] ${level.toUpperCase()}: ${message}`;
    switch (level) {
      case CONFIG.LOGGING.LEVELS.ERROR:
        console.error(consoleMessage, Object.keys(data).length > 0 ? data : '');
        break;
      case CONFIG.LOGGING.LEVELS.WARN:
        console.warn(consoleMessage, Object.keys(data).length > 0 ? data : '');
        break;
      case CONFIG.LOGGING.LEVELS.INFO:
        console.log(consoleMessage, Object.keys(data).length > 0 ? data : '');
        break;
      case CONFIG.LOGGING.LEVELS.DEBUG:
        if (process.env.DEBUG) {
          console.debug(consoleMessage, Object.keys(data).length > 0 ? data : '');
        }
        break;
    }
  },
  error(message, data) { this.log(CONFIG.LOGGING.LEVELS.ERROR, message, data); },
  warn(message, data) { this.log(CONFIG.LOGGING.LEVELS.WARN, message, data); },
  info(message, data) { this.log(CONFIG.LOGGING.LEVELS.INFO, message, data); },
  debug(message, data) { this.log(CONFIG.LOGGING.LEVELS.DEBUG, message, data); }
};

// Retry utility
async function withRetry(operation, operationName, maxAttempts = CONFIG.API.RETRY_ATTEMPTS) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await rateLimiter.waitForSlot();
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
      await new Promise(resolve => setTimeout(resolve, CONFIG.API.RETRY_DELAY * attempt));
    }
  }
  throw lastError;
}

function isRetryableError(error) {
  return (
    error.code === 'ECONNRESET' ||
    error.code === 'ETIMEDOUT' ||
    error.code === 'ECONNREFUSED' ||
    (error.response && error.response.status >= 500)
  );
}

// API logging configuration
const LOG_API_CONFIG = {
  enabled: process.env.LOG_API_ENABLED === 'true',
  endpoint: process.env.LOG_API_ENDPOINT || '',
  apiKey: process.env.LOG_API_KEY || ''
};

async function sendLogToApi(logData) {
  if (!LOG_API_CONFIG.enabled || !LOG_API_CONFIG.endpoint) {
    logger.debug('API logging disabled or endpoint not configured');
    return;
  }
  try {
    const headers = {
      'Content-Type': 'application/json'
    };
    if (LOG_API_CONFIG.apiKey) {
      headers['Authorization'] = `Bearer ${LOG_API_CONFIG.apiKey}`;
    }
    await axios.post(LOG_API_CONFIG.endpoint, logData, {
      headers,
      timeout: CONFIG.API.REQUEST_TIMEOUT
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

async function fetchTradablePairs() {
  return withRetry(
    async () => {
      const pairsResp = await kraken.api('AssetPairs');
      pairs = pairsResp.result;
      for (const pairInfo of Object.values(pairs)) {
        if (pairInfo.base && pairInfo.quote === FIAT && pairInfo.ordermin) {
          minimumOrderSizes[pairInfo.base] = parseFloat(pairInfo.ordermin);
        }
      }
      logger.info('Tradable pairs and minimum order sizes loaded', {
        pairCount: Object.keys(pairs).length,
        minimumOrderSizesCount: Object.keys(minimumOrderSizes).length
      });
    },
    'FetchTradablePairs'
  );
}

async function getOrderStatus(txid) {
  try {
    const orderResp = await kraken.api('QueryOrders', {
      txid: txid,
      trades: true
    });
    const order = orderResp.result[txid];
    if (!order) {
      logger.warn(`Order ${txid} not found`);
      return null;
    }
    const usdValue = parseFloat(order.cost) || 0;
    const volume = parseFloat(order.vol) || 0;
    const price = parseFloat(order.price) || 0;
    logger.info(`Order ${txid} status:`, {
      status: order.status,
      description: order.descr?.order,
      volume: volume,
      price: price,
      usdValue: usdValue,
      fee: order.fee,
      trades: order.trades?.length || 0
    });
    return {
      status: order.status,
      usdValue: usdValue,
      volume: volume,
      price: price,
      fee: order.fee,
      trades: order.trades
    };
  } catch (err) {
    logger.error(`Error getting order status for ${txid}:`, err.message);
    return null;
  }
}

async function getTradeDetails(tradeIds) {
  if (!Array.isArray(tradeIds)) {
    tradeIds = [tradeIds];
  }
  try {
    const tradesResp = await kraken.api('QueryTrades', {
      txid: tradeIds.join(',')
    });
    const trades = tradesResp.result;
    let totalUsd = 0;
    let totalFee = 0;
    for (const [txid, trade] of Object.entries(trades)) {
      const usdValue = parseFloat(trade.cost) || 0;
      const fee = parseFloat(trade.fee) || 0;
      totalUsd += usdValue;
      totalFee += fee;
      logger.info(`Trade ${txid} details:`, {
        pair: trade.pair,
        type: trade.type,
        ordertype: trade.ordertype,
        price: trade.price,
        cost: usdValue,
        fee: fee,
        vol: trade.vol,
        margin: trade.margin,
        misc: trade.misc
      });
    }
    logger.info('Trade summary:', {
      totalTrades: Object.keys(trades).length,
      totalUsdValue: totalUsd,
      totalFees: totalFee,
      netUsdValue: totalUsd - totalFee
    });
    return {
      trades,
      totalUsd,
      totalFee,
      netUsd: totalUsd - totalFee
    };
  } catch (err) {
    logger.error('Error getting trade details:', err.message);
    return null;
  }
}

function convertAssetName(asset) {
  if (asset === 'USD') return 'ZUSD';
  if (asset === 'DOGE') return 'XXDG';
  if (asset === 'ETH') return 'XETH';
  if (asset === 'BTC' || asset === 'XBT') return 'XXBT';
  return asset;
}

function processV2Balances(balances) {
  const newBalances = {};
  for (const balance of balances) {
    if (balance.asset && typeof balance.balance === 'number') {
      const asset = convertAssetName(balance.asset);
      newBalances[asset] = balance.balance.toString();
    }
  }
  return newBalances;
}

async function processBalanceChange(asset, oldAmount, newAmount, isSnapshot, logData) {
  const shouldProcess = !isSnapshot || oldAmount > 0;
  if (newAmount > 0 && shouldProcess) {
    logger.info(`Processing ${isSnapshot ? 'snapshot' : 'update'} balance for ${asset}: ${newAmount}`);
    await processBalance(asset, newAmount);
  } else if (newAmount > 0) {
    logger.info(`Skipping ${isSnapshot ? 'snapshot' : 'update'} balance for ${asset}: ${newAmount} (already processed)`);
  }
  logData.balances[asset] = {
    amount: newAmount,
    changed: newAmount !== oldAmount
  };
  if (newAmount !== oldAmount) {
    logData.changes.push({
      asset,
      oldAmount,
      newAmount
    });
  }
  return newAmount !== oldAmount;
}

async function handleBalanceUpdate(balances, isSnapshot = false) {
  const logData = {
    eventType: 'balance_update',
    timestamp: new Date().toISOString(),
    balances: {},
    changes: [],
    isSnapshot
  };
  if (isSnapshot) {
    logger.info('Processing initial WebSocket snapshot...');
  }
  if (Array.isArray(balances)) {
    balances = processV2Balances(balances);
  }
  let hasChanges = false;
  for (const [asset, amount] of Object.entries(balances)) {
    const newTotalAmount = parseFloat(amount);
    if (isNaN(newTotalAmount)) {
      logger.warn(`Skipping invalid balance for ${asset}: ${amount}`);
      continue;
    }
    const oldAmount = parseFloat(currentBalances[asset] || 0);
    currentBalances[asset] = amount;
    const changed = await processBalanceChange(asset, oldAmount, newTotalAmount, isSnapshot, logData);
    hasChanges = hasChanges || changed;
  }
  if (hasChanges) {
    logger.info(`Balance ${isSnapshot ? 'snapshot' : 'updates'}:`);
    logData.changes.forEach(change => {
      logger.info(`  ${change.asset}: ${change.oldAmount} -> ${change.newAmount}`);
    });
    if (LOG_API_CONFIG.enabled) {
      await sendLogToApi(logData);
    }
  }
  if (isSnapshot) {
    logger.info('Initial WebSocket snapshot processing complete');
    initialProcessingComplete = true;
  }
}

async function getWebSocketToken() {
  return withRetry(
    async () => {
      const response = await kraken.api('GetWebSocketsToken');
      if (!response?.result?.token) {
        throw new Error('Missing WebSocket token');
      }
      logger.info('WebSocket token received', {
        tokenPreview: response.result.token.slice(0, 12) + '...'
      });
      return response.result.token;
    },
    'GetWebSocketsToken'
  );
}

async function processBalance(asset, totalAmount) {
  const logData = {
    eventType: 'sale_attempt',
    timestamp: new Date().toISOString(),
    asset,
    totalAmount,
    pair: null,
    orderType: 'market',
    status: 'pending'
  };
  try {
    if (typeof totalAmount !== 'number' || isNaN(totalAmount)) {
      throw new Error(`Invalid totalAmount: ${totalAmount}`);
    }
    if (totalAmount <= 0.00001) {
      logger.info(`Skipping ${asset} - amount too small`, {
        asset,
        amount: totalAmount,
        reason: 'below_minimum'
      });
      return false;
    }
    if (asset === FIAT) {
      logger.info(`Skipping ${asset} - target fiat currency`, {
        asset,
        reason: 'target_currency'
      });
      return false;
    }
    const pairKey = Object.keys(pairs).find(
      p => (pairs[p].base === asset && pairs[p].quote === FIAT)
    );
    if (!pairKey) {
      logger.warn(`No market for ${asset}`, {
        asset,
        targetFiat: FIAT,
        reason: 'no_market'
      });
      return false;
    }
    logData.pair = pairKey;
    const ordermin = minimumOrderSizes[asset];
    if (!ordermin) {
      logger.warn(`No minimum order size for ${asset}`, {
        asset,
        reason: 'no_minimum_size'
      });
      return false;
    }
    if (totalAmount < ordermin) {
      logger.info(`Waiting for more ${asset}`, {
        asset,
        current: totalAmount,
        minimum: ordermin,
        reason: 'below_minimum_order'
      });
      return false;
    }
    return await withRetry(
      async () => {
        logger.info(`Placing sell order for ${asset}`, {
          eventType: 'sale_attempt',
          asset,
          amount: totalAmount,
          pair: pairKey,
          type: 'market'
        });
        const orderResp = await kraken.api('AddOrder', {
          pair: pairKey,
          type: 'sell',
          ordertype: 'market',
          volume: totalAmount.toString(),
          validate: false
        });
        const orderResult = orderResp.result;
        logData.status = 'success';
        logData.orderResponse = orderResult;
        logData.eventType = 'order_placed';
        let txids = [];
        if (Array.isArray(orderResult.txid)) {
          txids = orderResult.txid;
        } else if (orderResult.txid) {
          txids = [orderResult.txid];
        }
        logData.orderId = txids[0];
        logData.orderDetails = {
          description: orderResult.descr?.order,
          status: orderResult.status || 'open',
          txids: txids,
          pair: pairKey,
          volume: totalAmount,
          type: 'market',
          side: 'sell'
        };
        if (txids.length > 0) {
          logger.info(`Waiting for order ${txids[0]} to complete...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
          const orderStatus = await getOrderStatus(txids[0]);
          await orderStatus?.trades && getTradeDetails(orderStatus.trades);
        }
        console.log(`[${new Date().toISOString()}] INFO: Order placed for ${asset}`, {
          asset,
          orderId: txids[0],
          pair: pairKey,
          status: orderResult.status || 'open'
        });
        if (LOG_API_CONFIG.enabled) {
          await sendLogToApi(logData);
        }
        return true;
      },
      `PlaceOrder-${asset}`
    );
  } catch (err) {
    logData.status = 'error';
    logData.error = err.message;
    logData.eventType = 'order_failed';
    logger.error(`Error processing ${asset}`, {
      eventType: 'order_failed',
      asset,
      error: err.message,
      stack: err.stack,
      amount: totalAmount
    });
    if (LOG_API_CONFIG.enabled) {
      await sendLogToApi(logData);
    }
    return false;
  }
}

async function processAllBalances() {
  logger.info('Starting initial balance processing');
  const balancesResp = await kraken.api('Balance');
  const balances = balancesResp.result;
  const processedBalances = {
    total: 0,
    sold: 0,
    skipped: 0,
    waiting: 0
  };
  for (const [asset, amount] of Object.entries(balances)) {
    const totalAmount = parseFloat(amount);
    if (totalAmount > 0) {
      processedBalances.total++;
      logger.info(`Processing ${asset} balance`, {
        amount: totalAmount,
        asset
      });
      const result = await processBalance(asset, totalAmount);
      if (result === true) processedBalances.sold++;
      else if (totalAmount < 0.00001) processedBalances.skipped++;
      else processedBalances.waiting++;
    }
  }
  logger.info('Initial balance processing complete', {
    summary: processedBalances,
    timestamp: new Date().toISOString()
  });
  initialProcessingComplete = true;
}

function getWsInstance() { return wsInstance; }

async function startPrivateWebSocket(token) {
  if (!token || typeof token !== 'string' || token.length < 10) {
    logger.error('Invalid WebSocket token', {
      tokenLength: token?.length,
      reason: 'invalid_token'
    });
    return;
  }
  wsInstance = new WebSocket(CONFIG.API.ENDPOINTS.WS);
  const privateWs = wsInstance;
  let lastHeartbeatLog = 0;
  let hasReceivedSnapshot = false;
  let pingInterval;
  const connectionStartTime = Date.now();
  privateWs.on('open', () => {
    logger.info('WebSocket connected', {
      endpoint: CONFIG.API.ENDPOINTS.WS,
      tokenPreview: token.slice(0, 12) + '...'
    });
    const subscribeBalance = {
      method: 'subscribe',
      params: {
        channel: 'balances',
        token: token,
        snapshot: true
      }
    };
    logger.debug('Subscribing to balances', {
      method: subscribeBalance.method,
      channel: subscribeBalance.params.channel
    });
    privateWs.send(JSON.stringify(subscribeBalance));
    pingInterval = setInterval(() => {
      if (privateWs.readyState === WebSocket.OPEN) {
        privateWs.ping();
      }
    }, CONFIG.WEBSOCKET.PING_INTERVAL);
  });
  // Handler functions for message types
  async function handleBalancesMessage(message) {
    if (message.data) {
      if (!hasReceivedSnapshot && message.result?.snapshot === true) {
        logger.info('Received initial WebSocket snapshot');
        hasReceivedSnapshot = true;
        await handleBalanceUpdate(message.data, true);
      } else if (hasReceivedSnapshot) {
        logger.debug('Received balance update');
        await handleBalanceUpdate(message.data, false);
      }
    } else {
      logger.warn('Received balance message without data', { message });
    }
  }

  function handleHeartbeatMessage() {
    const now = Date.now();
    if (now - lastHeartbeatLog > 30000) {
      logger.debug('WebSocket heartbeat received', {
        connectionTime: Math.floor((now - lastHeartbeatLog) / 1000) + 's'
      });
      lastHeartbeatLog = now;
    }
  }

  function handleStatusMessage(message) {
    logger.info('System status update', {
      status: message.data?.[0]?.system || 'unknown'
    });
  }

  function handleErrorMessage(message) {
    logger.error('WebSocket error received', {
      error: message.error
    });
  }

  function handleSubscribeMessage(message) {
    logger.info('Subscription successful', {
      channel: message.result.channel,
      snapshot: message.result.snapshot
    });
  }

  privateWs.on('message', async (data) => {
    try {
      const message = JSON.parse(data);
      if (message.channel === 'balances') {
        await handleBalancesMessage(message);
      } else if (message.channel === 'heartbeat') {
        handleHeartbeatMessage();
      } else if (message.channel === 'status') {
        handleStatusMessage(message);
      } else if (message.error) {
        handleErrorMessage(message);
      } else if (message.method === 'subscribe' && message.result) {
        handleSubscribeMessage(message);
      } else if (message.channel !== 'heartbeat') {
        logger.debug('Received WebSocket message', { message });
      }
    } catch (err) {
      logger.error('Error processing WebSocket message', {
        error: err.message,
        stack: err.stack,
        rawMessage: data.toString()
      });
    }
  });
  privateWs.on('error', (error) => {
    logger.error('WebSocket error', {
      error: error.message,
      stack: error.stack
    });
  });
  privateWs.on('close', (code, reason) => {
    const connectionDuration = Math.floor((Date.now() - connectionStartTime) / 1000);
    logger.warn('WebSocket connection closed', {
      code,
      reason: reason.toString(),
      duration: `${connectionDuration}s`,
      willReconnect: true
    });
    if (pingInterval) {
      clearInterval(pingInterval);
    }
    setTimeout(async () => {
      try {
        logger.info('Attempting WebSocket reconnection');
        const newToken = await getWebSocketToken();
        startPrivateWebSocket(newToken);
      } catch (err) {
        logger.error('Reconnection failed', {
          error: err.message,
          stack: err.stack,
          retryIn: `${CONFIG.WEBSOCKET.RECONNECT_DELAY}ms`
        });
        setTimeout(() => startPrivateWebSocket(token), CONFIG.WEBSOCKET.RECONNECT_DELAY);
      }
    }, CONFIG.WEBSOCKET.RECONNECT_DELAY);
  });
  privateWs.on('pong', () => {
    logger.debug('WebSocket pong received');
  });
  return privateWs;
}

async function startWebSocket() {
  try {
    await fetchTradablePairs();
    await processAllBalances();
    const token = await getWebSocketToken();
    if (!token) {
      throw new Error('No WebSocket token obtained');
    }
    wsInstance = await startPrivateWebSocket(token);
  } catch (err) {
    logger.error('Error in WebSocket setup', {
      error: err.message,
      stack: err.stack
    });
    setTimeout(startWebSocket, CONFIG.WEBSOCKET.RECONNECT_DELAY);
  }
}

module.exports = {
  getWebSocketToken,
  processBalance,
  processAllBalances,
  handleBalanceUpdate,
  startPrivateWebSocket,
  startWebSocket,
  logger,
  currentBalances,
  initialProcessingComplete,
  lastRequestTime,
  getWsInstance
}; 