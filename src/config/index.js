require('dotenv').config();

const config = {
  // Server configuration
  server: {
    port: process.env.API_PORT || 3007,
    environment: process.env.NODE_ENV || 'development'
  },

  // Kraken API configuration
  kraken: {
    apiKey: process.env.KRAKEN_API_KEY,
    apiSecret: process.env.KRAKEN_API_SECRET,
    sandbox: process.env.KRAKEN_SANDBOX === 'true',
    targetFiat: process.env.TARGET_FIAT || 'USD',
    timeout: 10000,
    retryAttempts: 3,
    retryDelay: 1000,
    rateLimit: {
      maxRequests: 15,
      period: 1000
    },
    endpoints: {
      rest: process.env.KRAKEN_SANDBOX === 'true' 
        ? 'https://demo-futures.kraken.com/derivatives/api/v3' 
        : 'https://api.kraken.com/0',
      websocket: process.env.KRAKEN_SANDBOX === 'true'
        ? 'wss://demo-futures.kraken.com/ws/v1'
        : 'wss://ws-auth.kraken.com/v2'
    }
  },

  // WebSocket configuration
  websocket: {
    reconnectDelay: 5000,
    pingInterval: 30000,
    pongTimeout: 10000,
    heartbeatTimeout: 30000,
    maxReconnectAttempts: 10,
    baseReconnectDelay: 5000
  },

  // Logging configuration
  logging: {
    levels: {
      ERROR: 'error',
      WARN: 'warn',
      INFO: 'info',
      DEBUG: 'debug'
    },
    api: {
      enabled: process.env.LOG_API_ENABLED === 'true',
      endpoint: process.env.LOG_API_ENDPOINT || '',
      apiKey: process.env.LOG_API_KEY || ''
    }
  },

  // Auto-sell configuration
  autoSell: {
    // Minimum amounts are now fetched from Kraken API
    // No hardcoded values needed
  }
};

// Validate required environment variables
const requiredEnvVars = ['KRAKEN_API_KEY', 'KRAKEN_API_SECRET'];
const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingEnvVars.length > 0) {
  console.error('Error: Missing required environment variables:', missingEnvVars.join(', '));
  process.exit(1);
}

module.exports = config; 