require('dotenv').config();
const KrakenClient = require('kraken-api');
const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const qs = require('querystring');
const {
  getWebSocketToken,
  processBalance,
  processAllBalances,
  handleBalanceUpdate,
  startPrivateWebSocket,
  startWebSocket,
  logger,
  currentBalances,
  initialProcessingComplete,
  lastRequestTime
} = require('./kraken-auto-sell');

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

// Validate required environment variables
const requiredEnvVars = ['KRAKEN_API_KEY', 'KRAKEN_API_SECRET'];
const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingEnvVars.length > 0) {
  console.error('Error: Missing required environment variables:', missingEnvVars.join(', '));
  process.exit(1);
}

const apiKey = process.env.KRAKEN_API_KEY;
const apiSecret = process.env.KRAKEN_API_SECRET;
const FIAT = process.env.TARGET_FIAT || 'ZUSD';

// Initialize clients with timeouts and sandbox config
const kraken = new KrakenClient(apiKey, apiSecret, {
  timeout: CONFIG.API.REQUEST_TIMEOUT,
  sandbox: CONFIG.API.SANDBOX,
  baseUrl: CONFIG.API.ENDPOINTS.REST,
  version: CONFIG.API.SANDBOX ? 'v3' : '0'  // Futures API uses v3
});

// State management
let pairs = {};
let minimumOrderSizes = {};
let requestCount = 0;

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

// API logging configuration
const LOG_API_CONFIG = {
  enabled: process.env.LOG_API_ENABLED === 'true',
  endpoint: process.env.LOG_API_ENDPOINT || '',
  apiKey: process.env.LOG_API_KEY || ''
};

// Log configuration status at startup
logger.info('Application starting with configuration', {
  apiLogging: {
    enabled: LOG_API_CONFIG.enabled,
    endpoint: LOG_API_CONFIG.endpoint ? 'Configured' : 'Not configured',
    apiKey: LOG_API_CONFIG.apiKey ? 'Configured' : 'Not configured'
  },
  kraken: {
    sandbox: CONFIG.API.SANDBOX,
    apiEnvironment: CONFIG.API.SANDBOX ? 'Futures Demo' : 'Production',
    endpoints: {
      rest: CONFIG.API.ENDPOINTS.REST,
      websocket: CONFIG.API.ENDPOINTS.WS,
      apiVersion: CONFIG.API.SANDBOX ? 'v3' : '0'
    }
  },
  targetFiat: FIAT,
  websocket: {
    reconnectDelay: CONFIG.WEBSOCKET.RECONNECT_DELAY,
    pingInterval: CONFIG.WEBSOCKET.PING_INTERVAL
  },
  nodeEnvironment: process.env.NODE_ENV || 'development',
  orderMode: 'validation'  // Indicate that orders are in validation/dry-run mode
});

// Function to generate a nonce (unique number for each request)
function getNonce() {
  return Date.now() * 1000;
}

// Function to create the signature required for authenticated REST API calls
function getSignature(path, requestData, nonce) {
  const message = qs.stringify(requestData);
  const secret_buffer = Buffer.from(apiSecret, 'base64');
  const hash = crypto.createHash('sha256');
  const hmac = crypto.createHmac('sha512', secret_buffer);
  const nonceMessage = nonce + message;
  const hash_digest = hash.update(nonceMessage).digest();
  const hmac_digest = hmac.update(path + hash_digest).digest('base64');
  return hmac_digest;
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
      trades: true  // Include trade information
    });

    const order = orderResp.result[txid];
    if (!order) {
      logger.warn(`Order ${txid} not found`);
      return null;
    }

    // Calculate USD value
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

// Helper function to convert asset names
function convertAssetName(asset) {
  if (asset === 'USD') return 'ZUSD';
  if (asset === 'DOGE') return 'XXDG';
  if (asset === 'ETH') return 'XETH';
  if (asset === 'BTC' || asset === 'XBT') return 'XXBT';
  return asset;
}

// Helper function to process v2 API format
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

// Helper function to process balance changes
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

// Start the application
logger.info('Starting Kraken balance monitor...');
startWebSocket().catch(err => {
  logger.error('Failed to start application', {
    error: err.message,
    stack: err.stack
  });
  process.exit(1);
});