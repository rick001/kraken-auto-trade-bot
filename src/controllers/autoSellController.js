const autoSellService = require('../services/autoSellService');
const websocketService = require('../services/websocketService');
const { sendSuccessResponse } = require('../utils/errorHandler');

// Get status of the auto-sell service
exports.getStatus = (req, res) => {
  const ws = websocketService.getInstance();
  sendSuccessResponse(res, {
    status: 'running',
    initialProcessingComplete: autoSellService.isInitialProcessingComplete(),
    currentBalances: autoSellService.getCurrentBalances(),
    websocket: {
      connected: websocketService.isConnected(),
      lastUpdate: autoSellService.getLastRequestTime()
    }
  });
}; 