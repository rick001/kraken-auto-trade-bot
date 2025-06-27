const KrakenClient = require('kraken-api');
const config = require('../config');
const logger = require('../utils/logger');
const { withRetry, RateLimiter } = require('../utils/helpers');

class KrakenService {
  constructor() {
    this.kraken = new KrakenClient(
      config.kraken.apiKey,
      config.kraken.apiSecret,
      {
        timeout: config.kraken.timeout,
        sandbox: config.kraken.sandbox,
        baseUrl: config.kraken.endpoints.rest,
        version: config.kraken.sandbox ? 'v3' : '0'
      }
    );
    
    this.rateLimiter = new RateLimiter();
    this.pairs = {};
    this.minimumOrderSizes = {};
  }

  // Fetch tradable pairs and minimum order sizes
  async fetchTradablePairs() {
    return withRetry(
      async () => {
        await this.rateLimiter.waitForSlot();
        const pairsResp = await this.kraken.api('AssetPairs');
        this.pairs = pairsResp.result;
        
        for (const pairInfo of Object.values(this.pairs)) {
          if (pairInfo.base && pairInfo.quote === config.kraken.targetFiat && pairInfo.ordermin) {
            this.minimumOrderSizes[pairInfo.base] = parseFloat(pairInfo.ordermin);
          }
        }
        
        logger.info('Tradable pairs and minimum order sizes loaded', {
          pairCount: Object.keys(this.pairs).length,
          minimumOrderSizesCount: Object.keys(this.minimumOrderSizes).length,
          minimumOrderSizes: this.minimumOrderSizes
        });
      },
      'FetchTradablePairs'
    );
  }

  // Get order status
  async getOrderStatus(txid) {
    try {
      await this.rateLimiter.waitForSlot();
      const orderResp = await this.kraken.api('QueryOrders', {
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

  // Get trade details
  async getTradeDetails(tradeIds) {
    return withRetry(
      async () => {
        await this.rateLimiter.waitForSlot();
        const tradesResp = await this.kraken.api('QueryTrades', {
          txid: tradeIds.join(',')
        });
        return tradesResp.result;
      },
      'GetTradeDetails'
    );
  }

  // Get WebSocket token
  async getWebSocketToken() {
    return withRetry(
      async () => {
        await this.rateLimiter.waitForSlot();
        const tokenResp = await this.kraken.api('GetWebSocketsToken');
        const token = tokenResp.result.token;
        logger.info('WebSocket token received', {
          tokenPreview: token.substring(0, 12) + '...'
        });
        return token;
      },
      'GetWebSocketToken'
    );
  }

  // Get account balance
  async getAccountBalance() {
    return withRetry(
      async () => {
        await this.rateLimiter.waitForSlot();
        const balanceResp = await this.kraken.api('Balance');
        return balanceResp.result;
      },
      'GetAccountBalance'
    );
  }

  // Place a market sell order
  async placeMarketSellOrder(pair, volume) {
    return withRetry(
      async () => {
        await this.rateLimiter.waitForSlot();
        const orderResp = await this.kraken.api('AddOrder', {
          pair: pair,
          type: 'sell',
          ordertype: 'market',
          volume: volume.toString()
        });

        const txid = orderResp.result.txid[0];
        logger.info(`Market sell order placed`, {
          pair,
          volume,
          txid
        });

        return {
          txid,
          status: 'pending',
          pair,
          volume,
          type: 'market',
          ordertype: 'sell'
        };
      },
      'PlaceMarketSellOrder'
    );
  }

  // Get minimum order size for an asset
  getMinimumOrderSize(asset) {
    return this.minimumOrderSizes[asset] || 0.001; // Reasonable default if not found
  }

  // Check if asset has a market pair
  hasMarketPair(asset) {
    const pairName = `${asset}${config.kraken.targetFiat}`;
    return !!this.pairs[pairName];
  }

  // Get market pair name for an asset
  getMarketPair(asset) {
    const pairName = `${asset}${config.kraken.targetFiat}`;
    return this.pairs[pairName] ? pairName : null;
  }

  // Return all tradable pair names as an array
  getTradablePairs() {
    return Object.keys(this.pairs);
  }
}

module.exports = new KrakenService(); 