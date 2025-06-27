const autoSellService = require('./services/autoSellService');
const websocketService = require('./services/websocketService');
const krakenService = require('./services/krakenService');
const config = require('./config');
const logger = require('./utils/logger');

async function startServices() {
  try {
    logger.info('🚀 Starting Kraken Auto-Trade Bot Services');
    logger.info('==========================================');
    
    // Validate API configuration
    logger.info('📋 Configuration Check:');
    logger.info(`   Environment: ${config.server.environment}`);
    logger.info(`   Kraken Sandbox: ${config.kraken.sandbox}`);
    logger.info(`   Target Fiat: ${config.kraken.targetFiat}`);
    logger.info(`   WebSocket Endpoint: ${config.kraken.endpoints.websocket}`);
    logger.info(`   REST API Endpoint: ${config.kraken.endpoints.rest}`);
    
    // Validate API credentials and get account balance
    logger.info('🔑 Validating API credentials...');
    let balance;
    try {
      balance = await krakenService.getAccountBalance();
      logger.info('✅ API credentials validated successfully');
      logger.info(`   Account has ${Object.keys(balance).length} different assets`);
      
      // Show initial balance summary
      const totalAssets = Object.keys(balance).length;
      const nonZeroAssets = Object.entries(balance).filter(([_, amount]) => parseFloat(amount) > 0);
      
      logger.info('💰 Initial Balance Summary:');
      logger.info(`   Total assets: ${totalAssets}`);
      logger.info(`   Non-zero balances: ${nonZeroAssets.length}`);
      
      if (nonZeroAssets.length > 0) {
        logger.info('   Non-zero balances:');
        nonZeroAssets.forEach(([asset, amount]) => {
          const convertedAsset = require('./utils/helpers').convertAssetName(asset);
          logger.info(`     ${asset} (${convertedAsset}): ${amount}`);
        });
      }
      
    } catch (err) {
      logger.error('❌ API credential validation failed', {
        error: err.message,
        stack: err.stack
      });
      throw err;
    }
    
    // Fetch minimum order sizes only for assets we have
    logger.info('📊 Fetching minimum order sizes for account assets...');
    try {
      // Get list of assets we have (including zero balances for future deposits)
      const accountAssets = Object.keys(balance);
      await krakenService.fetchMinimumOrderSizesForAssets(accountAssets);
      logger.info(`✅ Loaded minimum order sizes for ${accountAssets.length} assets`);
    } catch (err) {
      logger.error('❌ Failed to fetch minimum order sizes', {
        error: err.message,
        stack: err.stack
      });
      throw err;
    }
    
    // Start initial balance processing
    logger.info('🔄 Starting initial balance processing...');
    await autoSellService.processAllBalances();
    logger.info('✅ Initial balance processing complete');

    // Wire up WebSocket event handlers
    logger.info('🔌 Setting up WebSocket event handlers...');
    websocketService.onBalanceUpdate = async (balances, isSnapshot, updateInfo) => {
      await autoSellService.handleBalanceUpdate(balances, isSnapshot, updateInfo);
    };
    websocketService.onDeposit = async (asset, amount) => {
      await autoSellService.handleDeposit(asset, amount);
    };
    logger.info('✅ WebSocket event handlers configured');

    // Start WebSocket connection
    logger.info('🌐 Starting WebSocket connection...');
    await websocketService.start();
    logger.info('✅ WebSocket service started');
    
    // Final status
    logger.info('🎉 All services started successfully!');
    logger.info('==========================================');
    logger.info('📡 Service Status:');
    logger.info(`   REST API: ✅ Ready`);
    logger.info(`   WebSocket: ✅ Connected`);
    logger.info(`   Auto-Sell: ✅ Active`);
    logger.info(`   Balance Monitoring: ✅ Active`);
    logger.info('==========================================');
    logger.info('🔔 Bot is now monitoring for new deposits and will auto-sell eligible assets');
    logger.info(`📊 API Documentation available at: http://localhost:${config.server.port}/api/docs`);
    logger.info(`🏥 Health check available at: http://localhost:${config.server.port}/api/health`);
    
  } catch (err) {
    logger.error('❌ Error starting services', { error: err.message, stack: err.stack });
    process.exit(1);
  }
}

if (require.main === module) {
  startServices();
}

module.exports = startServices; 