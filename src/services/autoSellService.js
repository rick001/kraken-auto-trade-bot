const config = require('../config');
const logger = require('../utils/logger');
const krakenService = require('./krakenService');
const { sendLogToApi, convertAssetName } = require('../utils/helpers');

class AutoSellService {
  constructor() {
    this.currentBalances = {};
    this.initialProcessingComplete = false;
    this.isProcessingSnapshot = false;
    this.lastRequestTime = Date.now();
  }

  // Process all balances on startup
  async processAllBalances() {
    logger.info('Starting initial balance processing');
    
    try {
      const balances = await krakenService.getAccountBalance();
      await this.handleBalanceUpdate(balances, true);
      this.initialProcessingComplete = true;
      logger.info('Initial balance processing complete', {
        summary: {
          total: Object.keys(balances).length,
          sold: 0,
          skipped: 0,
          waiting: 0
        },
        timestamp: new Date().toISOString()
      });
    } catch (err) {
      logger.error('Error processing initial balances', {
        error: err.message,
        stack: err.stack
      });
    }
  }

  // Handle balance updates (both snapshot and real-time)
  async handleBalanceUpdate(balances, isSnapshot = false) {
    if (this.isProcessingSnapshot && isSnapshot) {
      logger.debug('Already processing snapshot, skipping');
      return;
    }

    this.isProcessingSnapshot = isSnapshot;
    
    const changes = [];
    const logData = {
      timestamp: new Date().toISOString(),
      type: isSnapshot ? 'snapshot' : 'update',
      balances: balances,
      changes: []
    };

    for (const [asset, amount] of Object.entries(balances)) {
      const oldAmount = parseFloat(this.currentBalances[asset] || 0);
      const newAmount = parseFloat(amount);
      const changed = oldAmount !== newAmount;

      if (changed) {
        changes.push({ asset, oldAmount, newAmount });
        
        if (isSnapshot) {
          logger.debug(`Processing balance for ${asset} (converted: ${convertAssetName(asset)})`, {
            asset,
            convertedAsset: convertAssetName(asset),
            oldAmount,
            newAmount,
            changed
          });
        }

        await this.processBalanceChange(asset, oldAmount, newAmount, isSnapshot, logData);
      }
    }

    // Update current balances
    this.currentBalances = { ...balances };

    if (isSnapshot) {
      logger.info('Balance snapshot processed:', {
        changeCount: changes.length,
        changes
      });
      
      for (const change of changes) {
        logger.info(`  ${change.asset}: ${change.oldAmount} -> ${change.newAmount}`);
      }
    }

    // Send log to API if enabled
    if (config.logging.api.enabled) {
      await sendLogToApi(logData);
    }
  }

  // Process individual balance changes
  async processBalanceChange(asset, oldAmount, newAmount, isSnapshot, logData) {
    const convertedAsset = convertAssetName(asset);
    
    logger.debug(`Processing balance change for ${asset}`, {
      asset,
      oldAmount,
      newAmount,
      isSnapshot,
      shouldProcess: newAmount > 0 && !isSnapshot,
      willProcess: newAmount > 0 && !isSnapshot && newAmount > oldAmount
    });

    // For snapshots, process all non-zero balances
    if (isSnapshot && newAmount > 0) {
      logger.info(`Processing snapshot balance for ${asset}: ${newAmount}`);
      await this.processBalance(convertedAsset, newAmount);
      return;
    }

    // For updates, only process if it's a new deposit (amount increased)
    if (!isSnapshot && newAmount > oldAmount && newAmount > 0) {
      const depositAmount = newAmount - oldAmount;
      logger.info(`Processing new deposit: ${asset} ${depositAmount}`);
      await this.processBalance(convertedAsset, depositAmount);
    }
  }

  // Process a single balance for selling
  async processBalance(asset, totalAmount) {
    logger.info(`Processing ${asset} balance`, { amount: totalAmount, asset });

    // Skip if it's the target fiat currency (original or converted)
    const fiat = config.kraken.targetFiat;
    const fiatConverted = convertAssetName(fiat);
    if (asset === fiat || asset === fiatConverted) {
      logger.info(`Skipping ${asset} - target fiat currency`, {
        asset,
        reason: 'target_currency',
        fiat,
        fiatConverted
      });
      return;
    }

    // Check minimum amount
    const minimumAmount = config.autoSell.minimumAmounts[asset] || config.autoSell.defaultMinimum;
    if (totalAmount < minimumAmount) {
      logger.info(`Skipping ${asset} - amount too small`, { 
        asset, 
        amount: totalAmount, 
        reason: 'below_minimum' 
      });
      return;
    }

    // Check if there's a market pair
    if (!krakenService.hasMarketPair(asset)) {
      logger.warn(`No market for ${asset}`, { 
        asset, 
        targetFiat: config.kraken.targetFiat, 
        reason: 'no_market' 
      });
      return;
    }

    // Check minimum order size
    const minimumOrderSize = krakenService.getMinimumOrderSize(asset);
    if (totalAmount < minimumOrderSize) {
      logger.info(`Waiting for more ${asset}`, {
        asset,
        current: totalAmount,
        minimum: minimumOrderSize,
        reason: 'below_minimum_order'
      });
      return;
    }

    // Place sell order
    try {
      const pair = krakenService.getMarketPair(asset);
      const order = await krakenService.placeMarketSellOrder(pair, totalAmount);
      
      logger.info(`Market sell order placed for ${asset}`, {
        asset,
        amount: totalAmount,
        pair,
        txid: order.txid
      });

      // Monitor order status
      setTimeout(async () => {
        const orderStatus = await krakenService.getOrderStatus(order.txid);
        if (orderStatus) {
          logger.info(`Order ${order.txid} status updated`, {
            status: orderStatus.status,
            usdValue: orderStatus.usdValue,
            volume: orderStatus.volume,
            fee: orderStatus.fee
          });
        }
      }, 5000);

    } catch (err) {
      logger.error(`Failed to place sell order for ${asset}`, {
        asset,
        amount: totalAmount,
        error: err.message,
        stack: err.stack
      });
    }
  }

  // Handle deposit events from WebSocket
  async handleDeposit(asset, amount) {
    logger.info(`Handling deposit event: ${asset} ${amount}`);
    await this.processBalance(convertAssetName(asset), amount);
  }

  // Get current balances
  getCurrentBalances() {
    return this.currentBalances;
  }

  // Check if initial processing is complete
  isInitialProcessingComplete() {
    return this.initialProcessingComplete;
  }

  // Get last request time
  getLastRequestTime() {
    return this.lastRequestTime;
  }
}

module.exports = new AutoSellService(); 