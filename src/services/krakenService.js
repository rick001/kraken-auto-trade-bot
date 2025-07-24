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
        
        // Build minimum order sizes mapping for ALL pairs (legacy method)
        for (const [pairName, pairInfo] of Object.entries(this.pairs)) {
          // Convert target fiat to Kraken format for comparison
          const krakenTargetFiat = this.getOriginalAssetName(config.kraken.targetFiat);
          
          if (pairInfo.base && pairInfo.quote === krakenTargetFiat && pairInfo.ordermin) {
            // Convert Kraken asset name back to standard name for storage
            const standardAssetName = this.getStandardAssetName(pairInfo.base);
            this.minimumOrderSizes[standardAssetName] = parseFloat(pairInfo.ordermin);
            
            // Also store with original Kraken name as backup
            this.minimumOrderSizes[pairInfo.base] = parseFloat(pairInfo.ordermin);
            
            logger.debug(`Stored minimum order size for ${standardAssetName} (${pairInfo.base}): ${pairInfo.ordermin}`);
          }
        }
        
        // Debug: Log all XDG pairs to see what's actually available
        const allXDGPairs = Object.keys(this.pairs).filter(p => p.includes('XDG'));
        logger.info('All XDG pairs from Kraken API:', allXDGPairs);
        
        // Debug: Check for any USD pairs that might be DOGE-related
        const allUSDPairs = Object.keys(this.pairs).filter(p => p.endsWith('USD'));
        const dogeRelatedUSDPairs = allUSDPairs.filter(p => p.includes('XDG') || p.includes('DOGE'));
        logger.info('All USD pairs:', allUSDPairs.slice(0, 20));
        logger.info('DOGE/XDG related USD pairs:', dogeRelatedUSDPairs);
        
        // Debug: Check what pairs are available for XXDG specifically
        const xxdgPairs = Object.keys(this.pairs).filter(p => p.startsWith('XXDG'));
        logger.info('All XXDG pairs:', xxdgPairs);
        
        // Debug: Check what pairs are available for ZUSD specifically
        const zusdPairs = Object.keys(this.pairs).filter(p => p.endsWith('ZUSD'));
        logger.info('All ZUSD pairs:', zusdPairs.slice(0, 10));
        
        // Debug: Check for XXDGZUSD specifically
        const xxdgzusdPair = this.pairs['XXDGZUSD'];
        if (xxdgzusdPair) {
          logger.info('XXDGZUSD pair found:', xxdgzusdPair);
        } else {
          logger.warn('XXDGZUSD pair NOT found in available pairs');
        }
        
        // Debug: Check XDGUSD pair specifically
        const xdgusdPair = this.pairs['XDGUSD'];
        if (xdgusdPair) {
          logger.info('XDGUSD pair found:', {
            base: xdgusdPair.base,
            quote: xdgusdPair.quote,
            ordermin: xdgusdPair.ordermin,
            minimum: this.minimumOrderSizes['DOGE'],
            minimumXXDG: this.minimumOrderSizes['XXDG']
          });
        } else {
          logger.warn('XDGUSD pair NOT found in available pairs');
        }
        
        logger.info('Tradable pairs and minimum order sizes loaded', {
          pairCount: Object.keys(this.pairs).length,
          minimumOrderSizesCount: Object.keys(this.minimumOrderSizes).length,
          minimumOrderSizes: this.minimumOrderSizes,
          availablePairs: Object.keys(this.pairs).slice(0, 20), // Show first 20 pairs
          targetFiat: config.kraken.targetFiat,
          dogePairs: Object.keys(this.pairs).filter(p => p.includes('DOGE')), // Show all DOGE pairs
          xdgPairs: Object.keys(this.pairs).filter(p => p.includes('XDG')), // Show all XDG pairs
          xdgPairsCaseInsensitive: Object.keys(this.pairs).filter(p => p.toLowerCase().includes('xdg')), // Case insensitive
          allPairsWithUSD: Object.keys(this.pairs).filter(p => p.includes('USD') && (p.includes('XDG') || p.includes('DOGE'))), // All DOGE/XDG USD pairs
          solPairs: Object.keys(this.pairs).filter(p => p.includes('SOL')), // Show all SOL pairs
          btcPairs: Object.keys(this.pairs).filter(p => p.includes('XBT') || p.includes('BTC')), // Show all BTC pairs
          usdPairs: Object.keys(this.pairs).filter(p => p.endsWith('USD')).slice(0, 10) // Show first 10 USD pairs
        });
      },
      'FetchTradablePairs'
    );
  }

  // Fetch minimum order sizes only for specific assets (optimized)
  async fetchMinimumOrderSizesForAssets(assets) {
    return withRetry(
      async () => {
        await this.rateLimiter.waitForSlot();
        const pairsResp = await this.kraken.api('AssetPairs');
        this.pairs = pairsResp.result;
        
        // Convert target fiat to Kraken format for comparison
        const krakenTargetFiat = this.getOriginalAssetName(config.kraken.targetFiat);
        
        // Only process minimum order sizes for assets we have
        for (const asset of assets) {
          // Skip target fiat currency
          if (asset === config.kraken.targetFiat) {
            continue;
          }
          
          // Convert asset to Kraken format for pair lookup
          const krakenAsset = this.getOriginalAssetName(asset);
          
          // Look for pairs that match our asset and target fiat
          for (const [pairName, pairInfo] of Object.entries(this.pairs)) {
            if (pairInfo.base === krakenAsset && pairInfo.quote === krakenTargetFiat && pairInfo.ordermin) {
              // Convert Kraken asset name back to standard name for storage
              const standardAssetName = this.getStandardAssetName(pairInfo.base);
              this.minimumOrderSizes[standardAssetName] = parseFloat(pairInfo.ordermin);
              
              // Also store with original Kraken name as backup
              this.minimumOrderSizes[pairInfo.base] = parseFloat(pairInfo.ordermin);
              
              logger.debug(`Stored minimum order size for ${standardAssetName} (${pairInfo.base}): ${pairInfo.ordermin}`);
              break; // Found the pair, no need to continue searching
            }
          }
        }
        
        logger.info('Minimum order sizes loaded for account assets', {
          assetCount: assets.length,
          minimumOrderSizesCount: Object.keys(this.minimumOrderSizes).length,
          minimumOrderSizes: this.minimumOrderSizes,
          targetFiat: config.kraken.targetFiat
        });
      },
      'FetchMinimumOrderSizesForAssets'
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

  // Manually check balance for debugging
  async checkBalanceForAsset(asset) {
    try {
      await this.rateLimiter.waitForSlot();
      const balanceResp = await this.kraken.api('Balance');
      const balance = balanceResp.result;
      
      // Convert asset names for comparison
      const krakenAsset = this.getOriginalAssetName(asset);
      const standardAsset = this.getStandardAssetName(asset);
      
      const krakenBalance = parseFloat(balance[krakenAsset] || 0);
      const standardBalance = parseFloat(balance[standardAsset] || 0);
      
      logger.info(`Manual balance check for ${asset}:`, {
        asset,
        krakenAsset,
        standardAsset,
        krakenBalance,
        standardBalance,
        krakenBalanceRaw: balance[krakenAsset],
        standardBalanceRaw: balance[standardAsset],
        allBalances: balance
      });
      
      return {
        krakenAsset,
        standardAsset,
        krakenBalance,
        standardBalance,
        totalBalance: krakenBalance + standardBalance
      };
    } catch (err) {
      logger.error(`Error checking balance for ${asset}:`, err.message);
      return null;
    }
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
    const storedMinimum = this.minimumOrderSizes[asset];
    if (storedMinimum) {
      return storedMinimum;
    }
    
    // Asset-specific fallbacks based on common Kraken minimums
    const assetSpecificMinimums = {
      'BTC': 0.0001,
      'ETH': 0.001,
      'DOGE': 1,
      'SOL': 0.01,
      'XRP': 1,
      'LTC': 0.01,
      'ADA': 1,
      'DOT': 0.1,
      'LINK': 0.1,
      'UNI': 0.1
    };
    
    return assetSpecificMinimums[asset] || 0.001; // Generic fallback
  }

  // Check if asset has a market pair
  hasMarketPair(asset) {
    // Skip target fiat currency
    if (asset === config.kraken.targetFiat) {
      return false;
    }

    // Get Kraken asset name for the asset
    const krakenAsset = this.getOriginalAssetName(asset);
    const krakenQuote = this.getOriginalAssetName(config.kraken.targetFiat);
    
    // Try different pair name formats for Kraken
    const pairNames = [
      // Direct asset-quote pairs (most common)
      `${krakenAsset}${krakenQuote}`, // XETHZUSD, XDGZUSD
      `${asset}${config.kraken.targetFiat}`, // ETHUSD, DOGEUSD
      
      // Alternative formats
      `${krakenAsset}${config.kraken.targetFiat}`, // XETHUSD, XDGUSD
      `${asset}${krakenQuote}`, // ETHZUSD, DOGEZUSD
      
      // Standard USD pairs
      `${asset}USD`, // ETHUSD, DOGEUSD
      `${krakenAsset}USD`, // XETHUSD, XDGUSD
      
      // Special handling for DOGE (uses XDG in pair names)
      ...(asset === 'DOGE' ? ['XDGUSD', 'XDGZUSD'] : []),
      ...(krakenAsset === 'XXDG' ? ['XDGUSD', 'XDGZUSD'] : []),
      
      // Special handling for ETH (uses XETH in pair names)
      ...(asset === 'ETH' ? ['XETHUSD', 'XETHZUSD'] : []),
      ...(krakenAsset === 'XETH' ? ['XETHUSD', 'XETHZUSD'] : [])
    ];
    
    const hasPair = pairNames.some(pairName => !!this.pairs[pairName]);
    const foundPair = pairNames.find(pairName => !!this.pairs[pairName]);
    
    logger.debug(`Checking market pair for ${asset}`, {
      asset,
      krakenAsset,
      targetFiat: config.kraken.targetFiat,
      krakenQuote,
      triedPairs: pairNames,
      hasPair,
      foundPair,
      availablePairs: Object.keys(this.pairs).filter(p => p.includes(asset) || p.includes(krakenAsset)).slice(0, 5)
    });
    return hasPair;
  }

  // Get market pair name for an asset
  getMarketPair(asset) {
    // Skip target fiat currency
    if (asset === config.kraken.targetFiat) {
      return null;
    }

    // Get Kraken asset name for the asset
    const krakenAsset = this.getOriginalAssetName(asset);
    const krakenQuote = this.getOriginalAssetName(config.kraken.targetFiat);
    
    // Try different pair name formats for Kraken
    const pairNames = [
      // Direct asset-quote pairs (most common)
      `${krakenAsset}${krakenQuote}`, // XETHZUSD, XDGZUSD
      `${asset}${config.kraken.targetFiat}`, // ETHUSD, DOGEUSD
      
      // Alternative formats
      `${krakenAsset}${config.kraken.targetFiat}`, // XETHUSD, XDGUSD
      `${asset}${krakenQuote}`, // ETHZUSD, DOGEZUSD
      
      // Standard USD pairs
      `${asset}USD`, // ETHUSD, DOGEUSD
      `${krakenAsset}USD`, // XETHUSD, XDGUSD
      
      // Special handling for DOGE (uses XDG in pair names)
      ...(asset === 'DOGE' ? ['XDGUSD', 'XDGZUSD'] : []),
      ...(krakenAsset === 'XXDG' ? ['XDGUSD', 'XDGZUSD'] : []),
      
      // Special handling for ETH (uses XETH in pair names)
      ...(asset === 'ETH' ? ['XETHUSD', 'XETHZUSD'] : []),
      ...(krakenAsset === 'XETH' ? ['XETHUSD', 'XETHZUSD'] : [])
    ];
    
    const foundPair = pairNames.find(pairName => !!this.pairs[pairName]);
    
    // Log the found pair for debugging
    if (foundPair) {
      logger.debug(`Found market pair for ${asset}: ${foundPair}`, {
        asset,
        krakenAsset,
        targetFiat: config.kraken.targetFiat,
        foundPair,
        availablePairs: Object.keys(this.pairs).filter(p => p.includes(asset) || p.includes(krakenAsset)).slice(0, 5)
      });
    }
    
    return foundPair || null;
  }

  // Get original Kraken asset name from converted name
  getOriginalAssetName(asset) {
    const reverseConversions = {
      'ETH': 'XETH',
      'BTC': 'XXBT',
      'DOGE': 'XXDG',
      'USD': 'ZUSD',
      'USDT': 'USDT',
      'USDC': 'USDC',
      'EUR': 'ZEUR',
      'GBP': 'ZGBP',
      'CAD': 'ZCAD',
      'AUD': 'ZAUD',
      'JPY': 'ZJPY',
      'CHF': 'CHF',
      'XRP': 'XXRP',
      'XLM': 'XXLM',
      'XMR': 'XXMR',
      'LTC': 'XLTC',
      'ETC': 'XETC',
      'REP': 'XREP',
      'MLN': 'XMLN',
      'ZEC': 'XZEC'
    };
    return reverseConversions[asset] || asset;
  }

  // Get Kraken pair name for an asset (different from asset name)
  getPairName(asset) {
    const pairConversions = {
      'DOGE': 'XDG',  // DOGE uses XDG in pair names, not XXDG
      'BTC': 'XBT',   // BTC uses XBT in pair names, not XXBT
      'ETH': 'ETH',   // ETH uses ETH in pair names
      'USD': 'ZUSD',  // USD uses ZUSD in pair names, not USD
      'USDT': 'USDT',
      'USDC': 'USDC',
      'EUR': 'EUR',   // EUR uses EUR in pair names, not ZEUR
      'GBP': 'GBP',   // GBP uses GBP in pair names, not ZGBP
      'CAD': 'CAD',   // CAD uses CAD in pair names, not ZCAD
      'AUD': 'AUD',   // AUD uses AUD in pair names, not ZAUD
      'JPY': 'JPY',   // JPY uses JPY in pair names, not ZJPY
      'CHF': 'CHF',
      'XRP': 'XRP',   // XRP uses XRP in pair names, not XXRP
      'XLM': 'XLM',   // XLM uses XLM in pair names, not XXLM
      'XMR': 'XMR',   // XMR uses XMR in pair names, not XXMR
      'LTC': 'LTC',   // LTC uses LTC in pair names, not XLTC
      'ETC': 'ETC',   // ETC uses ETC in pair names, not XETC
      'REP': 'REP',   // REP uses REP in pair names, not XREP
      'MLN': 'MLN',   // MLN uses MLN in pair names, not XMLN
      'ZEC': 'ZEC'    // ZEC uses ZEC in pair names, not XZEC
    };
    return pairConversions[asset] || asset;
  }

  // Get standard asset name from Kraken asset name
  getStandardAssetName(krakenAsset) {
    const standardConversions = {
      'XXDG': 'DOGE',
      'XXBT': 'BTC',
      'XETH': 'ETH',
      'ZUSD': 'USD',
      'ZEUR': 'EUR',
      'ZGBP': 'GBP',
      'ZCAD': 'CAD',
      'ZAUD': 'AUD',
      'ZJPY': 'JPY',
      'XXRP': 'XRP',
      'XXLM': 'XLM',
      'XXMR': 'XMR',
      'XLTC': 'LTC',
      'XETC': 'ETC',
      'XREP': 'REP',
      'XMLN': 'MLN',
      'XZEC': 'ZEC'
    };
    return standardConversions[krakenAsset] || krakenAsset;
  }

  // Return all tradable pair names as an array
  getTradablePairs() {
    return Object.keys(this.pairs);
  }
}

module.exports = new KrakenService(); 