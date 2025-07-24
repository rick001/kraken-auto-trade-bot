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
      // Note: Initial snapshot is not sent to API as it doesn't match the expected event format
      // Only individual deposit and sale events are logged
    } catch (err) {
      logger.error('Error processing initial balances', {
        error: err.message,
        stack: err.stack
      });
    }
  }

  // Handle balance updates (both snapshot and real-time)
  async handleBalanceUpdate(balances, isSnapshot = false, updateInfo = null) {
    if (this.isProcessingSnapshot && isSnapshot) {
      logger.debug('Already processing snapshot, skipping');
      return;
    }

    this.isProcessingSnapshot = isSnapshot;
    
    const changes = [];
    const logData = {
      timestamp: new Date().toISOString(),
      eventType: isSnapshot ? 'snapshot' : 'update',
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

        await this.processBalanceChange(asset, oldAmount, newAmount, isSnapshot, logData, updateInfo);
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

    // Send log to API if enabled - only for snapshots, not for individual updates
    // Note: Snapshots are not sent to API as they don't match the expected event format
    // Only individual deposit and sale events are logged
  }

  // Process individual balance changes
  async processBalanceChange(asset, oldAmount, newAmount, isSnapshot, logData, updateInfo) {
    const convertedAsset = convertAssetName(asset);
    const depositAmount = newAmount - oldAmount;
    let saleTriggered = false;

    logger.debug(`Processing balance change for ${asset}`, {
      asset,
      oldAmount,
      newAmount,
      isSnapshot,
      updateType: updateInfo?.type,
      shouldProcess: newAmount > 0 && !isSnapshot,
      willProcess: newAmount > 0 && !isSnapshot && newAmount > oldAmount && updateInfo?.type !== 'trade'
    });

    // For snapshots, process all non-zero balances
    if (isSnapshot && newAmount > 0) {
      logger.info(`Processing snapshot balance for ${asset}: ${newAmount}`);
      await this.processBalance(convertedAsset, newAmount);
      return;
    }

    // For updates, only process if it's a new deposit (amount increased) AND not a trade result
    if (!isSnapshot && newAmount > oldAmount && newAmount > 0 && updateInfo?.type !== 'trade') {
      logger.info(`Processing new deposit: ${asset} ${depositAmount}`);
      // Log the deposit event (do not crash on error)
      if (config.logging.api.enabled) {
        try {
          await sendLogToApi({
            eventType: 'deposit',
            timestamp: updateInfo?.timestamp || new Date().toISOString(),
            asset: convertedAsset,
            amount: depositAmount,
            balance: newAmount,
            ledgerId: updateInfo?.ledger_id || null,
            refId: updateInfo?.ref_id || null
          });
        } catch (err) {
          logger.error('Failed to send deposit log to API', { error: err.message });
        }
      }
      // Try to process a sale of the total balance (not just the deposit)
      saleTriggered = await this.processBalance(convertedAsset, newAmount);
      // If a sale was triggered, log the sale event (handled in processBalance)
      return;
    }

    // Log ignored trade results for debugging
    if (!isSnapshot && updateInfo?.type === 'trade') {
      logger.debug(`Ignoring trade result for ${asset}: ${depositAmount > 0 ? '+' : ''}${depositAmount}`, {
        asset,
        oldAmount,
        newAmount,
        depositAmount,
        updateType: updateInfo.type,
        reason: 'trade_result'
      });
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
      return false;
    }

    // Check if there's a market pair
    if (!krakenService.hasMarketPair(asset)) {
      logger.warn(`No market for ${asset}`, { 
        asset, 
        targetFiat: config.kraken.targetFiat, 
        reason: 'no_market' 
      });
      return false;
    }

    // Check minimum order size (Kraken's real minimum)
    const minimumOrderSize = krakenService.getMinimumOrderSize(asset);
    if (totalAmount < minimumOrderSize) {
      logger.info(`Skipping ${asset} - amount too small`, { 
        asset, 
        amount: totalAmount, 
        minimum: minimumOrderSize,
        reason: 'below_minimum_order' 
      });
      return false;
    }

    // Check actual available balance before placing order
    try {
      const actualBalance = await krakenService.checkBalanceForAsset(asset);
      const availableAmount = Math.min(totalAmount, actualBalance.totalBalance);
      
      if (availableAmount < minimumOrderSize) {
        logger.info(`Skipping ${asset} - available balance too small`, { 
          asset, 
          requestedAmount: totalAmount,
          availableAmount,
          minimum: minimumOrderSize,
          reason: 'insufficient_available_balance' 
        });
        return false;
      }
      
      logger.info(`Using available balance for ${asset}`, {
        asset,
        requestedAmount: totalAmount,
        availableAmount,
        actualBalance: actualBalance.totalBalance
      });
      
      // Use the smaller of requested amount or available balance
      totalAmount = availableAmount;
    } catch (err) {
      logger.warn(`Could not verify balance for ${asset}, proceeding with original amount`, {
        asset,
        amount: totalAmount,
        error: err.message
      });
    }

    // Place sell order with retry logic
    const maxRetries = 3;
    let lastError;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const pair = krakenService.getMarketPair(asset);
        const order = await krakenService.placeMarketSellOrder(pair, totalAmount);
        logger.info(`Market sell order placed for ${asset}`, {
          asset,
          amount: totalAmount,
          pair,
          txid: order.txid,
          attempt
        });
        
        // Log the sale event (do not crash on error)
        if (config.logging.api.enabled) {
          try {
            await sendLogToApi({
              eventType: 'sale',
              timestamp: new Date().toISOString(),
              asset,
              amount: totalAmount,
              pair,
              txid: order.txid
            });
          } catch (err) {
            logger.error('Failed to send sale log to API', { error: err.message });
          }
        }
        
        // Monitor order status
        setTimeout(async () => {
          try {
            const orderStatus = await krakenService.getOrderStatus(order.txid);
            if (orderStatus) {
              logger.info(`Order ${order.txid} status updated`, {
                status: orderStatus.status,
                usdValue: orderStatus.usdValue,
                volume: orderStatus.volume,
                fee: orderStatus.fee
              });
              
              // If order was partially filled, try to sell remaining balance
              if (orderStatus.status === 'closed' && orderStatus.volume < totalAmount) {
                const remainingAmount = totalAmount - orderStatus.volume;
                logger.info(`Order partially filled, attempting to sell remaining ${remainingAmount} ${asset}`);
                setTimeout(() => this.processBalance(asset, remainingAmount), 2000);
              }
            }
          } catch (err) {
            logger.warn(`Could not get order status for ${order.txid}`, {
              error: err.message,
              txid: order.txid
            });
          }
        }, 5000);
        
        return true;
      } catch (err) {
        lastError = err;
        logger.warn(`Failed to place sell order for ${asset} (attempt ${attempt}/${maxRetries})`, {
          asset,
          amount: totalAmount,
          error: err.message,
          attempt,
          maxRetries
        });
        
        if (attempt < maxRetries) {
          // Wait before retry (exponential backoff)
          await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
        }
      }
    }
    
    logger.error(`Failed to place sell order for ${asset} after ${maxRetries} attempts`, {
      asset,
      amount: totalAmount,
      error: lastError.message,
      stack: lastError.stack
    });
    return false;
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