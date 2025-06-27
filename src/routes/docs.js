const express = require('express');
const swaggerUi = require('swagger-ui-express');

const router = express.Router();

// Detailed OpenAPI spec (from kraken-service.js)
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
          tradeId: { type: 'string', description: 'Unique trade identifier', example: 'TZA4L6-SGPSP-HF3TFV' },
          pair: { type: 'string', description: 'Trading pair', example: 'SOLUSD' },
          type: { type: 'string', description: 'Trade type (buy/sell)', example: 'sell' },
          ordertype: { type: 'string', description: 'Order type', example: 'market' },
          price: { type: 'number', description: 'Trade price', example: 141.09 },
          cost: { type: 'number', description: 'Total cost in quote currency', example: 25.01429 },
          fee: { type: 'number', description: 'Trade fee', example: 0.10006 },
          volume: { type: 'number', description: 'Trade volume', example: 0.17729314 },
          margin: { type: 'string', description: 'Margin information', example: '0.00000' },
          timestamp: { type: 'string', format: 'date-time', description: 'Trade timestamp', example: '2025-06-27T06:19:28.885Z' },
          misc: { type: 'string', description: 'Additional trade information', example: '' }
        }
      },
      Order: {
        type: 'object',
        properties: {
          orderId: { type: 'string', description: 'Order transaction ID', example: 'O2PMS2-VM6HC-5MQQOH' },
          status: { type: 'string', description: 'Order status', example: 'closed', enum: ['open', 'closed', 'canceled', 'pending'] },
          description: { type: 'string', description: 'Order description', example: 'sell 0.17729314 SOLUSD @ market' },
          volume: { type: 'number', description: 'Order volume', example: 0.17729314 },
          price: { type: 'number', description: 'Order price', example: 141.09 },
          cost: { type: 'number', description: 'Total cost', example: 25.01429 },
          fee: { type: 'number', description: 'Order fee', example: 0.10006 },
          timestamp: { type: 'string', format: 'date-time', description: 'Order creation timestamp', example: '2025-06-27T06:19:25.477Z' },
          closeTime: { type: 'string', format: 'date-time', description: 'Order close timestamp', example: '2025-06-27T06:19:28.489Z' },
          trades: { type: 'array', items: { $ref: '#/components/schemas/Trade' } }
        }
      },
      AutoSellStatus: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'Service status', example: 'running' },
          timestamp: { type: 'string', format: 'date-time', description: 'Status timestamp', example: '2025-06-27T06:19:44.881Z' },
          initialProcessingComplete: { type: 'boolean', description: 'Whether initial balance processing is complete', example: true },
          currentBalances: { type: 'object', description: 'Current account balances', example: { 'SOL': '0', 'TRUMP': '0', 'USDC': '0', 'USDT': '0', 'XETH': '0', 'XXBT': '0', 'XXDG': '12.00427438', 'ZUSD': '181.9629' } },
          websocket: {
            type: 'object',
            properties: {
              connected: { type: 'boolean', description: 'WebSocket connection status', example: true },
              lastUpdate: { type: 'string', format: 'date-time', description: 'Last WebSocket update', example: '2025-06-27T06:19:44.881Z' }
            }
          }
        }
      },
      HealthStatus: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'Overall health status', example: 'ok' },
          timestamp: { type: 'string', format: 'date-time', description: 'Health check timestamp', example: '2025-06-27T06:19:44.881Z' },
          environment: { type: 'string', description: 'Environment name', example: 'development' },
          kraken: {
            type: 'object',
            properties: {
              sandbox: { type: 'boolean', description: 'Whether using sandbox mode', example: false },
              endpoints: {
                type: 'object',
                properties: {
                  REST: { type: 'string', description: 'REST API endpoint', example: 'https://api.kraken.com/0' },
                  WS: { type: 'string', description: 'WebSocket endpoint', example: 'wss://ws-auth.kraken.com' }
                }
              }
            }
          },
          services: {
            type: 'object',
            properties: {
              api: { type: 'string', description: 'API service status', example: 'running' },
              autoSell: { type: 'string', description: 'Auto-sell service status', example: 'running' }
            }
          }
        }
      },
      Error: {
        type: 'object',
        properties: {
          error: { type: 'string', description: 'Error type', example: 'Order not found' },
          message: { type: 'string', description: 'Detailed error message', example: 'The specified order was not found in the system' }
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
                schema: { $ref: '#/components/schemas/Order' }
              }
            }
          },
          404: {
            description: 'Order not found',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' }
              }
            }
          },
          500: {
            description: 'Internal server error',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' }
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
                  additionalProperties: { $ref: '#/components/schemas/Order' }
                }
              }
            }
          },
          400: {
            description: 'Invalid request',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' }
              }
            }
          },
          500: {
            description: 'Internal server error',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' }
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
                schema: { $ref: '#/components/schemas/AutoSellStatus' }
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
                schema: { $ref: '#/components/schemas/HealthStatus' }
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
          200: { description: 'Swagger UI interface' }
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
                schema: { type: 'object' }
              }
            }
          }
        }
      }
    }
  }
};

// Serve Swagger UI and OpenAPI JSON
router.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));
router.get('/openapi.json', (req, res) => res.json(swaggerDocument));

module.exports = router; 