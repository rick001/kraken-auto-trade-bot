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
        : 'wss://ws-auth.kraken.com/v2'
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
let lastRequestTime = Date.now();
let wsInstance = null;
let lastNonce = Date.now() * 1000; // Add nonce tracking
let isReconnecting = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY = 5000;

// Add connection health tracking
let lastHeartbeatTime = Date.now();
let heartbeatCheckInterval = null;
const HEARTBEAT_TIMEOUT = 30000; // 30 seconds without heartbeat

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
    
    // Add minimum delay between requests to prevent nonce issues
    const timeSinceLastRequest = now - lastRequestTime;
    if (timeSinceLastRequest < 100) { // Minimum 100ms between requests
      await new Promise(resolve => setTimeout(resolve, 100 - timeSinceLastRequest));
    }
    lastRequestTime = Date.now();
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
    (error.response && error.response.status >= 500) ||
    error.message.includes('Invalid nonce') ||
    error.message.includes('API:Invalid nonce')
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
      headers['x-secret-key'] = LOG_API_CONFIG.apiKey;
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
  
  return withRetry(
    async () => {
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
    },
    'GetTradeDetails'
  ).catch(err => {
    logger.error('Error getting trade details:', err.message);
    return null;
  });
}

function convertAssetName(asset) {
  // Handle common asset name variations
  const conversions = {
    'USD': 'ZUSD',
    'DOGE': 'XXDG',
    'ETH': 'XETH',
    'BTC': 'XXBT',
    'XBT': 'XXBT',
    'SOL': 'SOL', // Keep as is
    'TRUMP': 'TRUMP', // Keep as is
    'USDC': 'USDC', // Keep as is
    'USDT': 'USDT', // Keep as is
    'XETH': 'XETH', // Already correct
    'XXBT': 'XXBT', // Already correct
    'XXDG': 'XXDG', // Already correct
    'ZUSD': 'ZUSD'  // Already correct
  };
  
  return conversions[asset] || asset;
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
  // Process any balance > 0, whether from snapshot or update
  const shouldProcess = newAmount > 0;
  
  logger.debug(`Processing balance change for ${asset}`, {
    asset,
    oldAmount,
    newAmount,
    isSnapshot,
    shouldProcess,
    willProcess: newAmount > 0 && shouldProcess
  });
  
  if (newAmount > 0 && shouldProcess) {
    logger.info(`Processing ${isSnapshot ? 'snapshot' : 'update'} balance for ${asset}: ${newAmount}`);
    await processBalance(asset, newAmount);
  } else if (newAmount > 0) {
    logger.info(`Skipping ${isSnapshot ? 'snapshot' : 'update'} balance for ${asset}: ${newAmount} (already processed)`);
  } else if (newAmount === 0 && oldAmount > 0) {
    logger.info(`Balance for ${asset} reduced to zero: ${oldAmount} -> ${newAmount}`);
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
  
  logger.info(`Processing balance ${isSnapshot ? 'snapshot' : 'update'}`, {
    isSnapshot,
    balanceCount: Object.keys(balances).length,
    assets: Object.keys(balances)
  });
  
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
    const convertedAsset = convertAssetName(asset);
    
    logger.debug(`Processing balance for ${asset} (converted: ${convertedAsset})`, {
      asset,
      convertedAsset,
      oldAmount,
      newAmount: newTotalAmount,
      changed: newTotalAmount !== oldAmount
    });
    
    currentBalances[asset] = amount;
    const changed = await processBalanceChange(asset, oldAmount, newTotalAmount, isSnapshot, logData);
    hasChanges = hasChanges || changed;
  }
  
  if (hasChanges) {
    logger.info(`Balance ${isSnapshot ? 'snapshot' : 'updates'} processed:`, {
      changeCount: logData.changes.length,
      changes: logData.changes
    });
    logData.changes.forEach(change => {
      logger.info(`  ${change.asset}: ${change.oldAmount} -> ${change.newAmount}`);
    });
    if (LOG_API_CONFIG.enabled) {
      await sendLogToApi(logData);
    }
  } else {
    logger.debug('No balance changes detected', {
      isSnapshot,
      balanceCount: Object.keys(balances).length
    });
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
          
          // Log the actual order status instead of assuming 'open'
          const actualStatus = orderStatus?.status || 'unknown';
          logger.info(`Order placed for ${asset}`, {
            asset,
            orderId: txids[0],
            pair: pairKey,
            status: actualStatus
          });
          
          // Only try to get trade details if order is closed and has trades
          if (orderStatus?.status === 'closed' && orderStatus?.trades) {
            try {
              await getTradeDetails(orderStatus.trades);
            } catch (tradeError) {
              logger.warn(`Failed to get trade details for ${asset}`, {
                asset,
                orderId: txids[0],
                error: tradeError.message
              });
            }
          }
        } else {
          logger.info(`Order placed for ${asset}`, {
            asset,
            orderId: 'unknown',
            pair: pairKey,
            status: 'pending'
          });
        }
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
      endpoint: CONFIG.API.ENDPOINTS.WS + '/v2',
      tokenPreview: token.substring(0, 12) + '...'
    });
    
    // Start heartbeat monitoring
    startHeartbeatMonitoring();
    
    // Subscribe to balances
    const subscribeMessage = {
      method: 'subscribe',
      params: {
        channel: 'balances',
        token: token
      }
    };
    
    logger.debug('Subscribing to balances channel', {
      method: subscribeMessage.method,
      channel: subscribeMessage.params.channel
    });
    
    privateWs.send(JSON.stringify(subscribeMessage));
    
    pingInterval = setInterval(() => {
      if (privateWs.readyState === WebSocket.OPEN) {
        privateWs.ping();
      }
    }, CONFIG.WEBSOCKET.PING_INTERVAL);
  });
  // Handler functions for message types
  async function handleBalancesMessage(message) {
    logger.debug('Received WebSocket balance message', {
      channel: message.channel,
      type: message.type,
      hasData: !!message.data,
      dataLength: message.data?.length || 0
    });
    
    if (message.data && Array.isArray(message.data)) {
      if (message.type === 'snapshot') {
        logger.info('Received initial WebSocket balance snapshot');
        // Convert v2 format to our expected format
        const balances = {};
        for (const balance of message.data) {
          balances[balance.asset] = balance.balance.toString();
        }
        await handleBalanceUpdate(balances, true);
      } else if (message.type === 'update') {
        // Add prominent debug logging for real-time balance updates
        console.log('🔔 REAL-TIME BALANCE UPDATE:', JSON.stringify(message.data, null, 2));
        logger.info('Received balance update via WebSocket');
        
        // Process individual balance updates
        for (const update of message.data) {
          logger.info(`Balance update: ${update.asset} ${update.type} ${update.amount}`, {
            asset: update.asset,
            type: update.type,
            amount: update.amount,
            balance: update.balance,
            ledgerId: update.ledger_id
          });
          
          // Update current balances
          currentBalances[update.asset] = update.balance.toString();
          
          // If it's a deposit, process it for selling
          if (update.type === 'deposit' && update.amount > 0) {
            logger.info(`Processing new deposit: ${update.asset} ${update.amount}`);
            await processBalance(update.asset, update.amount);
          }
        }
      }
    } else {
      logger.warn('Received balance message without data', { message });
    }
  }

  function handleHeartbeatMessage() {
    const now = Date.now();
    lastHeartbeatTime = now;
    
    if (now - lastHeartbeatLog > 300000) { // 5 minutes instead of 30 seconds
      logger.debug('WebSocket heartbeat received', {
        connectionTime: Math.floor((now - lastHeartbeatLog) / 1000) + 's'
      });
      lastHeartbeatLog = now;
    }
  }

  // Add connection health monitoring
  function startHeartbeatMonitoring() {
    if (heartbeatCheckInterval) {
      clearInterval(heartbeatCheckInterval);
    }
    
    heartbeatCheckInterval = setInterval(() => {
      const now = Date.now();
      const timeSinceLastHeartbeat = now - lastHeartbeatTime;
      
      if (timeSinceLastHeartbeat > HEARTBEAT_TIMEOUT) {
        logger.warn('No heartbeat received, connection may be stale', {
          timeSinceLastHeartbeat: `${Math.floor(timeSinceLastHeartbeat / 1000)}s`,
          timeout: `${HEARTBEAT_TIMEOUT / 1000}s`
        });
        
        // Force reconnection if no heartbeat for too long
        if (privateWs.readyState === WebSocket.OPEN) {
          logger.info('Forcing WebSocket reconnection due to missed heartbeats');
          privateWs.close(1000, 'Missed heartbeats');
        }
      }
    }, 10000); // Check every 10 seconds
  }

  function handleStatusMessage(message) {
    logger.info('System status update', {
      status: message.data?.[0]?.system || 'unknown'
    });
  }

  function handleErrorMessage(message) {
    logger.error('WebSocket error received', {
      error: message.error,
      event: message.event,
      status: message.status,
      errorMessage: message.errorMessage
    });
    
    // Handle subscription errors
    if (message.event === 'subscriptionStatus' && message.status === 'error') {
      logger.error('WebSocket subscription failed', {
        errorMessage: message.errorMessage,
        event: message.event,
        willRetry: true
      });
      
      // Only retry subscription errors if it's not a permanent error
      const permanentErrors = ['Event(s) not found', 'Invalid channel', 'Invalid token'];
      const isPermanentError = permanentErrors.some(err => 
        message.errorMessage && message.errorMessage.includes(err)
      );
      
      if (!isPermanentError) {
        // Try to resubscribe after a delay
        setTimeout(async () => {
          try {
            logger.info('Attempting to resubscribe to balances...');
            const newToken = await getWebSocketToken();
            if (newToken && privateWs.readyState === WebSocket.OPEN) {
              const resubscribeMessage = {
                method: 'subscribe',
                params: {
                  channel: 'balances',
                  token: newToken
                }
              };
              privateWs.send(JSON.stringify(resubscribeMessage));
              logger.info('Resubscription message sent');
            } else {
              logger.warn('Cannot resubscribe - connection not ready or no token');
            }
          } catch (err) {
            logger.error('Failed to resubscribe', { error: err.message });
          }
        }, 5000);
      } else {
        logger.error('Permanent subscription error, will not retry', {
          errorMessage: message.errorMessage
        });
      }
    }
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
      
      // Add prominent logging for real-time balance updates
      if (message.channel === 'balances' && message.type === 'update') {
        console.log('🔔 REAL-TIME BALANCE UPDATE:', JSON.stringify(message.data, null, 2));
      }
      
      // Log all messages for debugging (except heartbeats to reduce log noise)
      if (message.channel !== 'heartbeat') {
        logger.debug('Received WebSocket message', { 
          event: message.event,
          channel: message.channel,
          type: message.type,
          status: message.status,
          hasData: !!message.data,
          hasResult: !!message.result
        });
      }
      
      if (message.channel === 'balances') {
        await handleBalancesMessage(message);
      } else if (message.channel === 'heartbeat') {
        handleHeartbeatMessage();
      } else if (message.channel === 'status') {
        handleStatusMessage(message);
      } else if (message.event === 'subscriptionStatus') {
        if (message.status === 'error') {
          handleErrorMessage(message);
        } else if (message.status === 'subscribed') {
          handleSubscribeMessage(message);
        }
      } else if (message.error || message.errorMessage) {
        handleErrorMessage(message);
      } else if (message.method === 'subscribe' && message.result) {
        handleSubscribeMessage(message);
      } else if (message.event === 'systemStatus') {
        logger.info('System status received', { status: message.status });
      } else if (message.channel !== 'heartbeat') {
        logger.debug('Unhandled WebSocket message', { message });
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
      willReconnect: true,
      reconnectAttempts
    });
    
    if (pingInterval) {
      clearInterval(pingInterval);
    }
    
    if (heartbeatCheckInterval) {
      clearInterval(heartbeatCheckInterval);
    }
    
    // Prevent multiple simultaneous reconnection attempts
    if (isReconnecting) {
      logger.warn('Reconnection already in progress, skipping');
      return;
    }
    
    isReconnecting = true;
    
    // Calculate exponential backoff delay
    const delay = Math.min(BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts), 60000); // Max 60 seconds
    
    setTimeout(async () => {
      try {
        logger.info('Attempting WebSocket reconnection', {
          attempt: reconnectAttempts + 1,
          maxAttempts: MAX_RECONNECT_ATTEMPTS,
          delay
        });
        
        const newToken = await getWebSocketToken();
        if (newToken) {
          await startPrivateWebSocket(newToken);
          reconnectAttempts = 0; // Reset on successful connection
          logger.info('WebSocket reconnection successful');
        } else {
          throw new Error('Failed to obtain new WebSocket token');
        }
      } catch (err) {
        reconnectAttempts++;
        logger.error('Reconnection failed', {
          error: err.message,
          attempt: reconnectAttempts,
          maxAttempts: MAX_RECONNECT_ATTEMPTS,
          retryIn: delay
        });
        
        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          // Schedule next reconnection attempt
          setTimeout(() => {
            isReconnecting = false;
            startPrivateWebSocket(token);
          }, delay);
        } else {
          logger.error('Max reconnection attempts reached, giving up', {
            totalAttempts: reconnectAttempts
          });
          isReconnecting = false;
          // Could implement additional fallback here (e.g., REST API polling)
        }
      } finally {
        isReconnecting = false;
      }
    }, delay);
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