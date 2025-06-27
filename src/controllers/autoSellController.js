const autoSellService = require('../services/autoSellService');
const websocketService = require('../services/websocketService');

// Get status of the auto-sell service
exports.getStatus = (req, res) => {
  const ws = websocketService.getInstance();
  res.json({
    status: 'running',
    timestamp: new Date().toISOString(),
    initialProcessingComplete: autoSellService.isInitialProcessingComplete(),
    currentBalances: autoSellService.getCurrentBalances(),
    websocket: {
      connected: websocketService.isConnected(),
      lastUpdate: autoSellService.getLastRequestTime()
    }
  });
}; 