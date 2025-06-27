require('dotenv').config();
const express = require('express');
const KrakenClient = require('kraken-api');
const cors = require('cors');
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
    REQUEST_TIMEOUT: 10000,
    SANDBOX: process.env.KRAKEN_SANDBOX === 'true',
    ENDPOINTS: {
      REST: process.env.KRAKEN_SANDBOX === 'true' 
        ? 'https://demo-futures.kraken.com/derivatives/api/v3' 
        : 'https://api.kraken.com/0'
    }
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

// Helper function to format trade data (for API endpoints)
function formatTradeData(order, trades, txid = null) {
  // Add debugging for order structure
  if (!order) {
    console.warn('formatTradeData: order is null or undefined');
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

  // Debug logging for order structure
  if (!order.txid && !txid) {
    console.warn('formatTradeData: order.txid is missing and no txid parameter provided', {
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
    const tradeData = formatTradeData(order, trades, txid);
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
    title: 'Kraken Auto-Trade Bot API',
    version: '1.0.0',
    description: 'Unified API for Kraken auto-sell service and trade details. Provides real-time balance monitoring, automated selling, and trade history querying.',
    contact: {
      name: 'API Support',
      url: 'https://github.com/rick001/kraken-auto-trade-bot'
    }
  },
  servers: [
    { 
      url: 'http://localhost:3007',
      description: 'Development server'
    }
  ],
  components: {
    schemas: {
      Trade: {
        type: 'object',
        properties: {
          tradeId: {
            type: 'string',
            description: 'Unique trade identifier',
            example: 'TZA4L6-SGPSP-HF3TFV'
          },
          pair: {
            type: 'string',
            description: 'Trading pair',
            example: 'SOLUSD'
          },
          type: {
            type: 'string',
            description: 'Trade type (buy/sell)',
            example: 'sell'
          },
          ordertype: {
            type: 'string',
            description: 'Order type',
            example: 'market'
          },
          price: {
            type: 'number',
            description: 'Trade price',
            example: 141.09
          },
          cost: {
            type: 'number',
            description: 'Total cost in quote currency',
            example: 25.01429
          },
          fee: {
            type: 'number',
            description: 'Trade fee',
            example: 0.10006
          },
          volume: {
            type: 'number',
            description: 'Trade volume',
            example: 0.17729314
          },
          margin: {
            type: 'string',
            description: 'Margin information',
            example: '0.00000'
          },
          timestamp: {
            type: 'string',
            format: 'date-time',
            description: 'Trade timestamp',
            example: '2025-06-27T06:19:28.885Z'
          },
          misc: {
            type: 'string',
            description: 'Additional trade information',
            example: ''
          }
        }
      },
      Order: {
        type: 'object',
        properties: {
          orderId: {
            type: 'string',
            description: 'Order transaction ID',
            example: 'O2PMS2-VM6HC-5MQQOH'
          },
          status: {
            type: 'string',
            description: 'Order status',
            example: 'closed',
            enum: ['open', 'closed', 'canceled', 'pending']
          },
          description: {
            type: 'string',
            description: 'Order description',
            example: 'sell 0.17729314 SOLUSD @ market'
          },
          volume: {
            type: 'number',
            description: 'Order volume',
            example: 0.17729314
          },
          price: {
            type: 'number',
            description: 'Order price',
            example: 141.09
          },
          cost: {
            type: 'number',
            description: 'Total cost',
            example: 25.01429
          },
          fee: {
            type: 'number',
            description: 'Order fee',
            example: 0.10006
          },
          timestamp: {
            type: 'string',
            format: 'date-time',
            description: 'Order creation timestamp',
            example: '2025-06-27T06:19:25.477Z'
          },
          closeTime: {
            type: 'string',
            format: 'date-time',
            description: 'Order close timestamp',
            example: '2025-06-27T06:19:28.489Z'
          },
          trades: {
            type: 'array',
            items: {
              $ref: '#/components/schemas/Trade'
            }
          }
        }
      },
      AutoSellStatus: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            description: 'Service status',
            example: 'running'
          },
          timestamp: {
            type: 'string',
            format: 'date-time',
            description: 'Status timestamp',
            example: '2025-06-27T06:19:44.881Z'
          },
          initialProcessingComplete: {
            type: 'boolean',
            description: 'Whether initial balance processing is complete',
            example: true
          },
          currentBalances: {
            type: 'object',
            description: 'Current account balances',
            example: {
              'SOL': '0',
              'TRUMP': '0',
              'USDC': '0',
              'USDT': '0',
              'XETH': '0',
              'XXBT': '0',
              'XXDG': '12.00427438',
              'ZUSD': '181.9629'
            }
          },
          websocket: {
            type: 'object',
            properties: {
              connected: {
                type: 'boolean',
                description: 'WebSocket connection status',
                example: true
              },
              lastUpdate: {
                type: 'string',
                format: 'date-time',
                description: 'Last WebSocket update',
                example: '2025-06-27T06:19:44.881Z'
              }
            }
          }
        }
      },
      HealthStatus: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            description: 'Overall health status',
            example: 'ok'
          },
          timestamp: {
            type: 'string',
            format: 'date-time',
            description: 'Health check timestamp',
            example: '2025-06-27T06:19:44.881Z'
          },
          environment: {
            type: 'string',
            description: 'Environment name',
            example: 'development'
          },
          kraken: {
            type: 'object',
            properties: {
              sandbox: {
                type: 'boolean',
                description: 'Whether using sandbox mode',
                example: false
              },
              endpoints: {
                type: 'object',
                properties: {
                  REST: {
                    type: 'string',
                    description: 'REST API endpoint',
                    example: 'https://api.kraken.com/0'
                  },
                  WS: {
                    type: 'string',
                    description: 'WebSocket endpoint',
                    example: 'wss://ws-auth.kraken.com'
                  }
                }
              }
            }
          },
          services: {
            type: 'object',
            properties: {
              api: {
                type: 'string',
                description: 'API service status',
                example: 'running'
              },
              autoSell: {
                type: 'string',
                description: 'Auto-sell service status',
                example: 'running'
              }
            }
          }
        }
      },
      Error: {
        type: 'object',
        properties: {
          error: {
            type: 'string',
            description: 'Error type',
            example: 'Order not found'
          },
          message: {
            type: 'string',
            description: 'Detailed error message',
            example: 'The specified order was not found in the system'
          }
        }
      }
    }
  },
  paths: {
    '/api/trade/{txid}': {
      get: {
        summary: 'Get details for a single trade/order by transaction ID',
        description: 'Retrieves comprehensive information about a specific trade or order, including all associated trades, fees, and timing details.',
        parameters: [
          {
            name: 'txid',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: 'Transaction ID of the order to retrieve',
            example: 'O2PMS2-VM6HC-5MQQOH'
          }
        ],
        responses: {
          200: {
            description: 'Trade details retrieved successfully',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/Order'
                },
                example: {
                  orderId: 'O2PMS2-VM6HC-5MQQOH',
                  status: 'closed',
                  description: 'sell 0.17729314 SOLUSD @ market',
                  volume: 0.17729314,
                  price: 141.09,
                  cost: 25.01429,
                  fee: 0.10006,
                  timestamp: '2025-06-27T06:19:25.477Z',
                  closeTime: '2025-06-27T06:19:28.489Z',
                  trades: [
                    {
                      tradeId: 'TZA4L6-SGPSP-HF3TFV',
                      pair: 'SOLUSD',
                      type: 'sell',
                      ordertype: 'market',
                      price: 141.09,
                      cost: 25.01429,
                      fee: 0.10006,
                      volume: 0.17729314,
                      margin: '0.00000',
                      timestamp: '2025-06-27T06:19:28.885Z',
                      misc: ''
                    }
                  ]
                }
              }
            }
          },
          404: {
            description: 'Order not found',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/Error'
                },
                example: {
                  error: 'Order not found',
                  message: 'The specified order was not found in the system'
                }
              }
            }
          },
          500: {
            description: 'Internal server error',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/Error'
                }
              }
            }
          }
        }
      }
    },
    '/api/trades/batch': {
      post: {
        summary: 'Get details for multiple trades/orders by transaction IDs',
        description: 'Retrieves details for multiple trades or orders in a single request. Useful for batch processing and reducing API calls.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  txids: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Array of transaction IDs to retrieve',
                    minItems: 1,
                    maxItems: 20
                  }
                },
                required: ['txids']
              },
              example: {
                txids: ['O2PMS2-VM6HC-5MQQOH', 'ORMJND-5CYBJ-ZLBSJ5']
              }
            }
          }
        },
        responses: {
          200: {
            description: 'Batch trade details retrieved successfully',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: {
                    $ref: '#/components/schemas/Order'
                  }
                },
                example: {
                  'O2PMS2-VM6HC-5MQQOH': {
                    orderId: 'O2PMS2-VM6HC-5MQQOH',
                    status: 'closed',
                    description: 'sell 0.17729314 SOLUSD @ market',
                    volume: 0.17729314,
                    price: 141.09,
                    cost: 25.01429,
                    fee: 0.10006,
                    timestamp: '2025-06-27T06:19:25.477Z',
                    closeTime: '2025-06-27T06:19:28.489Z',
                    trades: []
                  },
                  'ORMJND-5CYBJ-ZLBSJ5': {
                    orderId: 'ORMJND-5CYBJ-ZLBSJ5',
                    status: 'closed',
                    description: 'sell 0.52571 TRUMPUSD @ market',
                    volume: 0.52571,
                    price: 8.987,
                    cost: 4.72508,
                    fee: 0.01890,
                    timestamp: '2025-06-27T06:19:29.637Z',
                    closeTime: '2025-06-27T06:19:32.347Z',
                    trades: []
                  }
                }
              }
            }
          },
          400: {
            description: 'Invalid request',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/Error'
                },
                example: {
                  error: 'Invalid request',
                  message: 'txids must be a non-empty array'
                }
              }
            }
          },
          500: {
            description: 'Internal server error',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/Error'
                }
              }
            }
          }
        }
      }
    },
    '/api/auto-sell/status': {
      get: {
        summary: 'Get status of the auto-sell service',
        description: 'Retrieves the current status of the auto-sell service, including balance information, WebSocket connectivity, and processing status.',
        responses: {
          200: {
            description: 'Auto-sell status retrieved successfully',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/AutoSellStatus'
                },
                example: {
                  status: 'running',
                  timestamp: '2025-06-27T06:19:44.881Z',
                  initialProcessingComplete: true,
                  currentBalances: {
                    'SOL': '0',
                    'TRUMP': '0',
                    'USDC': '0',
                    'USDT': '0',
                    'XETH': '0',
                    'XXBT': '0',
                    'XXDG': '12.00427438',
                    'ZUSD': '181.9629'
                  },
                  websocket: {
                    connected: true,
                    lastUpdate: '2025-06-27T06:19:44.881Z'
                  }
                }
              }
            }
          }
        }
      }
    },
    '/api/health': {
      get: {
        summary: 'Health check for the unified service',
        description: 'Performs a comprehensive health check of all service components, including API connectivity and auto-sell service status.',
        responses: {
          200: {
            description: 'Health check completed successfully',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/HealthStatus'
                },
                example: {
                  status: 'ok',
                  timestamp: '2025-06-27T06:19:44.881Z',
                  environment: 'development',
                  kraken: {
                    sandbox: false,
                    endpoints: {
                      REST: 'https://api.kraken.com/0',
                      WS: 'wss://ws-auth.kraken.com'
                    }
                  },
                  services: {
                    api: 'running',
                    autoSell: 'running'
                  }
                }
              }
            }
          }
        }
      }
    },
    '/api/docs': {
      get: {
        summary: 'API Documentation (Swagger UI)',
        description: 'Interactive API documentation and testing interface. Provides a web-based interface for exploring and testing all API endpoints.',
        responses: {
          200: {
            description: 'Swagger UI interface'
          }
        }
      }
    },
    '/api/openapi.json': {
      get: {
        summary: 'OpenAPI Specification',
        description: 'Returns the OpenAPI specification in JSON format for programmatic access.',
        responses: {
          200: {
            description: 'OpenAPI specification',
            content: {
              'application/json': {
                schema: {
                  type: 'object'
                }
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