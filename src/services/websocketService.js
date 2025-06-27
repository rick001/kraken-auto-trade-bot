const WebSocket = require('ws');
const config = require('../config');
const logger = require('../utils/logger');
const krakenService = require('./krakenService');

class WebSocketService {
  constructor() {
    this.wsInstance = null;
    this.isReconnecting = false;
    this.reconnectAttempts = 0;
    this.lastHeartbeatTime = Date.now();
    this.lastHeartbeatLog = 0;
    this.heartbeatCheckInterval = null;
    this.connectionStartTime = Date.now();
    this.pingInterval = null;
  }

  // Start WebSocket connection
  async start() {
    try {
      logger.info('🌐 Initializing WebSocket connection...');
      
      await krakenService.fetchTradablePairs();
      logger.info('📊 Tradable pairs loaded for WebSocket');
      
      const token = await krakenService.getWebSocketToken();
      if (!token) {
        throw new Error('No WebSocket token obtained');
      }
      logger.info('🔑 WebSocket token obtained successfully');
      
      this.wsInstance = await this.startPrivateWebSocket(token);
    } catch (err) {
      logger.error('❌ Error in WebSocket setup', {
        error: err.message,
        stack: err.stack
      });
      setTimeout(() => this.start(), config.websocket.reconnectDelay);
    }
  }

  // Start private WebSocket connection
  async startPrivateWebSocket(token) {
    logger.info('🔌 Establishing WebSocket connection...');
    const privateWs = new WebSocket(config.kraken.endpoints.websocket);
    
    privateWs.on('open', () => {
      logger.info('✅ WebSocket connected successfully', {
        endpoint: config.kraken.endpoints.websocket,
        tokenPreview: token.substring(0, 12) + '...',
        timestamp: new Date().toISOString()
      });
      
      this.startHeartbeatMonitoring();
      
      const subscribeMessage = {
        method: 'subscribe',
        params: {
          channel: 'balances',
          token: token
        }
      };
      
      logger.info('📡 Subscribing to balances channel...', {
        method: subscribeMessage.method,
        channel: subscribeMessage.params.channel,
        tokenPreview: token.substring(0, 12) + '...'
      });
      
      privateWs.send(JSON.stringify(subscribeMessage));
      
      this.pingInterval = setInterval(() => {
        if (privateWs.readyState === WebSocket.OPEN) {
          privateWs.ping();
        }
      }, config.websocket.pingInterval);
    });

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
          await this.handleBalancesMessage(message);
        } else if (message.channel === 'heartbeat') {
          this.handleHeartbeatMessage();
        } else if (message.channel === 'status') {
          this.handleStatusMessage(message);
        } else if (message.event === 'subscriptionStatus') {
          if (message.status === 'error') {
            this.handleErrorMessage(message);
          } else if (message.status === 'subscribed') {
            this.handleSubscribeMessage(message);
          }
        } else if (message.error || message.errorMessage) {
          this.handleErrorMessage(message);
        } else if (message.method === 'subscribe' && message.result) {
          this.handleSubscribeMessage(message);
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
      const connectionDuration = Math.floor((Date.now() - this.connectionStartTime) / 1000);
      logger.warn('WebSocket connection closed', {
        code,
        reason: reason.toString(),
        duration: `${connectionDuration}s`,
        willReconnect: true,
        reconnectAttempts: this.reconnectAttempts
      });
      
      if (this.pingInterval) {
        clearInterval(this.pingInterval);
      }
      
      if (this.heartbeatCheckInterval) {
        clearInterval(this.heartbeatCheckInterval);
      }
      
      // Prevent multiple simultaneous reconnection attempts
      if (this.isReconnecting) {
        logger.warn('Reconnection already in progress, skipping');
        return;
      }
      
      this.isReconnecting = true;
      
      // Calculate exponential backoff delay
      const delay = Math.min(
        config.websocket.baseReconnectDelay * Math.pow(2, this.reconnectAttempts), 
        60000
      );
      
      setTimeout(async () => {
        try {
          logger.info('Attempting WebSocket reconnection', {
            attempt: this.reconnectAttempts + 1,
            maxAttempts: config.websocket.maxReconnectAttempts,
            delay
          });
          
          const newToken = await krakenService.getWebSocketToken();
          if (newToken) {
            await this.startPrivateWebSocket(newToken);
            this.reconnectAttempts = 0; // Reset on successful connection
            logger.info('WebSocket reconnection successful');
          } else {
            throw new Error('Failed to obtain new WebSocket token');
          }
        } catch (err) {
          this.reconnectAttempts++;
          logger.error('Reconnection failed', {
            error: err.message,
            attempt: this.reconnectAttempts,
            maxAttempts: config.websocket.maxReconnectAttempts,
            retryIn: delay
          });
          
          if (this.reconnectAttempts < config.websocket.maxReconnectAttempts) {
            // Schedule next reconnection attempt
            setTimeout(() => {
              this.isReconnecting = false;
              this.startPrivateWebSocket(token);
            }, delay);
          } else {
            logger.error('Max reconnection attempts reached, giving up', {
              totalAttempts: this.reconnectAttempts
            });
            this.isReconnecting = false;
          }
        } finally {
          this.isReconnecting = false;
        }
      }, delay);
    });

    privateWs.on('pong', () => {
      // Removed: logger.debug('WebSocket pong received');
    });

    return privateWs;
  }

  // Handle balance messages
  async handleBalancesMessage(message) {
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
        // Emit balance update event
        this.emit('balanceUpdate', balances, true);
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
          
          // Emit individual balance update event with full update information
          this.emit('balanceUpdate', { [update.asset]: update.balance.toString() }, false, update);
          
          // If it's a deposit, emit deposit event
          if (update.type === 'deposit' && update.amount > 0) {
            logger.info(`Processing new deposit: ${update.asset} ${update.amount}`);
            this.emit('deposit', update.asset, update.amount);
          }
        }
      }
    } else {
      logger.warn('Received balance message without data', { message });
    }
  }

  // Handle heartbeat messages
  handleHeartbeatMessage() {
    const now = Date.now();
    this.lastHeartbeatTime = now;
    this.lastHeartbeatLog = now;
  }

  // Start heartbeat monitoring
  startHeartbeatMonitoring() {
    if (this.heartbeatCheckInterval) {
      clearInterval(this.heartbeatCheckInterval);
    }
    
    this.heartbeatCheckInterval = setInterval(() => {
      const now = Date.now();
      const timeSinceLastHeartbeat = now - this.lastHeartbeatTime;
      
      if (timeSinceLastHeartbeat > config.websocket.heartbeatTimeout) {
        logger.warn('No heartbeat received, connection may be stale', {
          timeSinceLastHeartbeat: `${Math.floor(timeSinceLastHeartbeat / 1000)}s`,
          timeout: `${config.websocket.heartbeatTimeout / 1000}s`
        });
        
        // Force reconnection if no heartbeat for too long
        if (this.wsInstance && this.wsInstance.readyState === WebSocket.OPEN) {
          logger.info('Forcing WebSocket reconnection due to missed heartbeats');
          this.wsInstance.close(1000, 'Missed heartbeats');
        }
      }
    }, 10000); // Check every 10 seconds
  }

  // Handle status messages
  handleStatusMessage(message) {
    logger.info('System status update', {
      status: message.data?.[0]?.system || 'unknown'
    });
  }

  // Handle error messages
  handleErrorMessage(message) {
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
            const newToken = await krakenService.getWebSocketToken();
            if (newToken && this.wsInstance.readyState === WebSocket.OPEN) {
              const resubscribeMessage = {
                method: 'subscribe',
                params: {
                  channel: 'balances',
                  token: newToken
                }
              };
              this.wsInstance.send(JSON.stringify(resubscribeMessage));
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

  // Handle subscribe messages
  handleSubscribeMessage(message) {
    logger.info('✅ Subscription successful', {
      channel: message.result?.channel || message.channel,
      snapshot: message.result?.snapshot || 'unknown',
      status: message.status,
      timestamp: new Date().toISOString()
    });
    
    if (message.result?.channel === 'balances') {
      logger.info('🎯 Successfully subscribed to real-time balance updates');
      logger.info('📊 Ready to receive balance snapshots and updates');
    }
  }

  // Get WebSocket instance
  getInstance() {
    return this.wsInstance;
  }

  // Check if connected
  isConnected() {
    return !!(this.wsInstance && this.wsInstance.readyState === WebSocket.OPEN);
  }

  // Event emitter methods (to be implemented by the auto-sell service)
  emit(event, ...args) {
    if (event === 'balanceUpdate' && this.onBalanceUpdate) {
      this.onBalanceUpdate(...args);
    } else if (event === 'deposit' && this.onDeposit) {
      this.onDeposit(...args);
    }
  }
}

module.exports = new WebSocketService(); 