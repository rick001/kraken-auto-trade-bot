require('dotenv').config();
const express = require('express');
const KrakenClient = require('kraken-api');
const cors = require('cors');

const app = express();
const port = process.env.API_PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Initialize Kraken client
const kraken = new KrakenClient(
  process.env.KRAKEN_API_KEY,
  process.env.KRAKEN_API_SECRET,
  {
    timeout: 10000,
    sandbox: process.env.KRAKEN_SANDBOX === 'true'
  }
);

// Helper function to format trade data
function formatTradeData(order, trades) {
  const orderData = {
    orderId: order.txid,
    status: order.status,
    description: order.descr?.order,
    volume: parseFloat(order.vol) || 0,
    price: parseFloat(order.price) || 0,
    cost: parseFloat(order.cost) || 0,
    fee: parseFloat(order.fee) || 0,
    timestamp: new Date(order.opentm * 1000).toISOString(),
    closeTime: order.closetm ? new Date(order.closetm * 1000).toISOString() : null,
    trades: []
  };

  if (trades) {
    orderData.trades = Object.entries(trades).map(([txid, trade]) => ({
      tradeId: txid,
      pair: trade.pair,
      type: trade.type,
      ordertype: trade.ordertype,
      price: parseFloat(trade.price) || 0,
      cost: parseFloat(trade.cost) || 0,
      fee: parseFloat(trade.fee) || 0,
      volume: parseFloat(trade.vol) || 0,
      margin: trade.margin,
      timestamp: new Date(trade.time * 1000).toISOString(),
      misc: trade.misc
    }));
  }

  return orderData;
}

// API Endpoints
app.get('/api/trade/:txid', async (req, res) => {
  try {
    const { txid } = req.params;
    
    // Get order details
    const orderResp = await kraken.api('QueryOrders', {
      txid: txid,
      trades: true
    });

    const order = orderResp.result[txid];
    if (!order) {
      return res.status(404).json({
        error: 'Order not found',
        txid
      });
    }

    // Get trade details if available
    let trades = null;
    if (order.trades?.length > 0) {
      const tradesResp = await kraken.api('QueryTrades', {
        txid: order.trades.join(',')
      });
      trades = tradesResp.result;
    }

    // Format and return the data
    const tradeData = formatTradeData(order, trades);
    res.json(tradeData);

  } catch (error) {
    console.error('Error fetching trade details:', error.message);
    res.status(500).json({
      error: 'Failed to fetch trade details',
      message: error.message
    });
  }
});

// Batch query endpoint
app.post('/api/trades/batch', async (req, res) => {
  try {
    const { txids } = req.body;
    
    if (!Array.isArray(txids) || txids.length === 0) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'txids must be a non-empty array'
      });
    }

    // Limit batch size
    if (txids.length > 20) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Maximum 20 txids per request'
      });
    }

    const results = {};
    for (const txid of txids) {
      try {
        const orderResp = await kraken.api('QueryOrders', {
          txid: txid,
          trades: true
        });

        const order = orderResp.result[txid];
        if (order) {
          let trades = null;
          if (order.trades?.length > 0) {
            const tradesResp = await kraken.api('QueryTrades', {
              txid: order.trades.join(',')
            });
            trades = tradesResp.result;
          }
          results[txid] = formatTradeData(order, trades);
        } else {
          results[txid] = { error: 'Order not found' };
        }
      } catch (err) {
        results[txid] = { error: err.message };
      }
    }

    res.json(results);

  } catch (error) {
    console.error('Error in batch query:', error.message);
    res.status(500).json({
      error: 'Failed to process batch request',
      message: error.message
    });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    kraken: {
      sandbox: process.env.KRAKEN_SANDBOX === 'true'
    }
  });
});

// Start server
app.listen(port, () => {
  console.log(`Kraken Trade API server running on port ${port}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Kraken Sandbox: ${process.env.KRAKEN_SANDBOX === 'true'}`);
}); 