require('dotenv').config();
const express = require('express');
const KrakenClient = require('kraken-api');
const WebSocket = require('ws');
const cors = require('cors');
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
  lastRequestTime,
  getWsInstance
} = require('./kraken-auto-sell');
const swaggerUi = require('swagger-ui-express');

/*
Kraken Unified Service API Documentation
=======================================

Base URL: http://localhost:3000

Endpoints:

1. GET /api/trade/:txid
   - Description: Get details for a single trade/order by transaction ID.
   - Params: txid (string, required)
   - Response: {
       orderId, status, description, volume, price, cost, fee, timestamp, closeTime, trades: [ ... ]
     }

2. POST /api/trades/batch
   - Description: Get details for multiple trades/orders by transaction IDs.
   - Body: { "txids": ["txid1", "txid2", ...] }
   - Response: { "txid1": { ... }, "txid2": { ... }, ... }

3. GET /api/auto-sell/status
   - Description: Get status of the auto-sell service (balances, websocket status, etc).
   - Response: { status, timestamp, initialProcessingComplete, currentBalances, websocket: { connected, lastUpdate } }

4. GET /api/health
   - Description: Health check for the unified service.
   - Response: { status, timestamp, environment, kraken: { sandbox, endpoints }, services: { api, autoSell } }

5. GET /api/docs
   - Description: API documentation (this page).
   - Response: HTML documentation.

Usage Examples:
---------------

# Get single trade details
curl http://localhost:3000/api/trade/O123456-7890-1234

# Get multiple trade details
curl -X POST http://localhost:3000/api/trades/batch \
  -H "Content-Type: application/json" \
  -d '{"txids": ["O123456-7890-1234", "O987654-3210-5678"]}'

# Check auto-sell status
curl http://localhost:3000/api/auto-sell/status

# Health check
curl http://localhost:3000/api/health

# API docs
curl http://localhost:3000/api/docs
*/

// Initialize Express app
const app = express();
const port = process.env.API_PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Constants and Configuration
const CONFIG = {
  API: {
    RETRY_ATTEMPTS: 3,
    RETRY_DELAY: 1000,
    REQUEST_TIMEOUT: 10000,
    RATE_LIMIT: {
      MAX_REQUESTS: 15,
      PERIOD: 1000
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
    RECONNECT_DELAY: 5000,
    PING_INTERVAL: 30000,
    PONG_TIMEOUT: 10000
  }
};

// Initialize Kraken client
const kraken = new KrakenClient(
  process.env.KRAKEN_API_KEY,
  process.env.KRAKEN_API_SECRET,
  {
    timeout: CONFIG.API.REQUEST_TIMEOUT,
    sandbox: CONFIG.API.SANDBOX,
    baseUrl: CONFIG.API.ENDPOINTS.REST
  }
);

// State management for auto-sell service
let pairs = {};
let minimumOrderSizes = {};
let isProcessingSnapshot = false;
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

// Helper function to format trade data (for API endpoints)
function formatTradeData(order, trades) {
  const orderData = {
    orderId: order.txid,
    status: order.status,
    description: order.descr?.order,
    volume: parseFloat(order.vol) || 0,
    price: parseFloat(order.price) || 0,
    cost: parseFloat(order.cost) || 0,
    fee: parseFloat(order.fee) || 0,
    timestamp: new Date(order.opentm * 1000).toISOString(),
    closeTime: order.closetm ? new Date(order.closetm * 1000).toISOString() : null,
    trades: []
  };

  if (trades) {
    orderData.trades = Object.entries(trades).map(([txid, trade]) => ({
      tradeId: txid,
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

// API Endpoints
app.get('/api/trade/:txid', async (req, res) => {
  try {
    const { txid } = req.params;
    
    // Get order details
    const orderResp = await kraken.api('QueryOrders', {
      txid: txid,
      trades: true
    });

    const order = orderResp.result[txid];
    if (!order) {
      return res.status(404).json({
        error: 'Order not found',
        txid
      });
    }

    // Get trade details if available
    let trades = null;
    if (order.trades?.length > 0) {
      const tradesResp = await kraken.api('QueryTrades', {
        txid: order.trades.join(',')
      });
      trades = tradesResp.result;
    }

    // Format and return the data
    const tradeData = formatTradeData(order, trades);
    res.json(tradeData);

  } catch (error) {
    console.error('Error fetching trade details:', error.message);
    res.status(500).json({
      error: 'Failed to fetch trade details',
      message: error.message
    });
  }
});

// Batch query endpoint
app.post('/api/trades/batch', async (req, res) => {
  try {
    const { txids } = req.body;
    
    if (!Array.isArray(txids) || txids.length === 0) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'txids must be a non-empty array'
      });
    }

    // Limit batch size
    if (txids.length > 20) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Maximum 20 txids per request'
      });
    }

    const results = {};
    for (const txid of txids) {
      try {
        const orderResp = await kraken.api('QueryOrders', {
          txid: txid,
          trades: true
        });

        const order = orderResp.result[txid];
        if (order) {
          let trades = null;
          if (order.trades?.length > 0) {
            const tradesResp = await kraken.api('QueryTrades', {
              txid: order.trades.join(',')
            });
            trades = tradesResp.result;
          }
          results[txid] = formatTradeData(order, trades);
        } else {
          results[txid] = { error: 'Order not found' };
        }
      } catch (err) {
        results[txid] = { error: err.message };
      }
    }

    res.json(results);

  } catch (error) {
    console.error('Error in batch query:', error.message);
    res.status(500).json({
      error: 'Failed to process batch request',
      message: error.message
    });
  }
});

// Auto-sell service status endpoint
app.get('/api/auto-sell/status', (req, res) => {
  const ws = getWsInstance();
  res.json({
    status: 'running',
    timestamp: new Date().toISOString(),
    initialProcessingComplete,
    currentBalances,
    websocket: {
      connected: !!(ws && ws.readyState === 1),
      lastUpdate: lastRequestTime
    }
  });
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  const ws = getWsInstance();
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    kraken: {
      sandbox: CONFIG.API.SANDBOX,
      endpoints: CONFIG.API.ENDPOINTS
    },
    services: {
      api: 'running',
      autoSell: (ws && ws.readyState === 1) ? 'running' : 'disconnected'
    }
  });
});

// Serve Swagger UI and OpenAPI JSON
const swaggerDocument = {
  openapi: '3.0.0',
  info: {
    title: 'Kraken Unified Service API',
    version: '1.0.0',
    description: 'API for Kraken auto-sell and trade details.'
  },
  servers: [
    { url: 'http://localhost:3000' }
  ],
  paths: {
    '/api/trade/{txid}': {
      get: {
        summary: 'Get details for a single trade/order by transaction ID',
        parameters: [
          {
            name: 'txid',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: 'Transaction ID'
          }
        ],
        responses: {
          200: {
            description: 'Trade details',
            content: {
              'application/json': {
                schema: { type: 'object' }
              }
            }
          },
          404: {
            description: 'Order not found'
          }
        }
      }
    },
    '/api/trades/batch': {
      post: {
        summary: 'Get details for multiple trades/orders by transaction IDs',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  txids: {
                    type: 'array',
                    items: { type: 'string' }
                  }
                },
                required: ['txids']
              }
            }
          }
        },
        responses: {
          200: {
            description: 'Batch trade details',
            content: {
              'application/json': {
                schema: { type: 'object' }
              }
            }
          },
          400: {
            description: 'Invalid request'
          }
        }
      }
    },
    '/api/auto-sell/status': {
      get: {
        summary: 'Get status of the auto-sell service',
        responses: {
          200: {
            description: 'Auto-sell status',
            content: {
              'application/json': {
                schema: { type: 'object' }
              }
            }
          }
        }
      }
    },
    '/api/health': {
      get: {
        summary: 'Health check for the unified service',
        responses: {
          200: {
            description: 'Health status',
            content: {
              'application/json': {
                schema: { type: 'object' }
              }
            }
          }
        }
      }
    }
  }
};

app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));
app.get('/api/openapi.json', (req, res) => res.json(swaggerDocument));

// Start both services
async function startServices() {
  try {
    // Start the Express server
    app.listen(port, () => {
      console.log(`Kraken unified service running on port ${port}`);
      console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`Kraken Sandbox: ${CONFIG.API.SANDBOX}`);
    });

    // Start the auto-sell service
    await startWebSocket();
  } catch (error) {
    console.error('Failed to start services:', error);
    process.exit(1);
  }
}

// Graceful shutdown
async function gracefulShutdown(signal) {
  console.log(`\nInitiating graceful shutdown (${signal})...`);
  
  // Close WebSocket connection
  if (global.ws) {
    console.log('Closing WebSocket connection...');
    global.ws.close();
  }
  
  // Clear any intervals
  if (global.pingInterval) {
    clearInterval(global.pingInterval);
  }
  
  console.log('Shutdown complete');
  process.exit(0);
}

// Process handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled promise rejection:', reason);
  process.exit(1);
});

// Start the unified service
console.log('Starting Kraken unified service...');
startServices().catch(error => {
  console.error('Failed to start services:', error);
  process.exit(1);
}); 