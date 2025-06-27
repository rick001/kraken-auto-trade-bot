# Kraken Auto-Trade Bot API - Quick Reference

## Base URL
```
http://localhost:3007
```

## Endpoints

| Method | Endpoint | Description | Example |
|--------|----------|-------------|---------|
| GET | `/api/health` | Health check | `curl http://localhost:3007/api/health` |
| GET | `/api/auto-sell/status` | Auto-sell service status | `curl http://localhost:3007/api/auto-sell/status` |
| GET | `/api/trade/{txid}` | Single trade details | `curl http://localhost:3007/api/trade/O2PMS2-VM6HC-5MQQOH` |
| POST | `/api/trades/batch` | Multiple trade details | `curl -X POST http://localhost:3007/api/trades/batch -H "Content-Type: application/json" -d '{"txids": ["O2PMS2-VM6HC-5MQQOH"]}'` |
| GET | `/api/docs` | Interactive API docs | Open in browser: `http://localhost:3007/api/docs` |
| GET | `/api/openapi.json` | OpenAPI spec | `curl http://localhost:3007/api/openapi.json` |

## Common Response Fields

### Trade/Order Response
```json
{
  "orderId": "string",
  "status": "closed|open|canceled|pending",
  "description": "string",
  "volume": "number",
  "price": "number",
  "cost": "number",
  "fee": "number",
  "timestamp": "ISO-8601",
  "closeTime": "ISO-8601",
  "trades": [...]
}
```

### Auto-Sell Status Response
```json
{
  "status": "running",
  "timestamp": "ISO-8601",
  "initialProcessingComplete": "boolean",
  "currentBalances": {...},
  "websocket": {
    "connected": "boolean",
    "lastUpdate": "ISO-8601"
  }
}
```

### Health Check Response
```json
{
  "status": "ok",
  "timestamp": "ISO-8601",
  "environment": "development|production",
  "kraken": {
    "sandbox": "boolean",
    "endpoints": {...}
  },
  "services": {
    "api": "running|error",
    "autoSell": "running|disconnected"
  }
}
```

## Error Responses
```json
{
  "error": "Error type",
  "message": "Detailed error message"
}
```

## Testing

### Run API Tests
```bash
node api-test.js
```

### Test Balance Detection
```bash
node debug-balances.js
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `API_PORT` | API server port | `3000` |
| `KRAKEN_API_KEY` | Kraken API key | Required |
| `KRAKEN_API_SECRET` | Kraken API secret | Required |
| `KRAKEN_SANDBOX` | Use sandbox mode | `false` |
| `TARGET_FIAT` | Target fiat currency | `ZUSD` |
| `DEBUG` | Enable debug logging | `false` |

## Quick Commands

### Start Service
```bash
node kraken-service.js
```

### Check Health
```bash
curl http://localhost:3007/api/health
```

### Monitor Balances
```bash
curl http://localhost:3007/api/auto-sell/status
```

### Get Trade Details
```bash
curl http://localhost:3007/api/trade/YOUR_TXID
```

### View API Docs
```bash
# Open in browser
http://localhost:3007/api/docs
```

## Troubleshooting

### Service Not Starting
1. Check API credentials in `.env`
2. Verify port availability
3. Check logs for errors

### WebSocket Disconnected
1. Check network connectivity
2. Verify API credentials
3. Check health endpoint

### Balance Not Detected
1. Enable debug mode: `set DEBUG=true`
2. Check auto-sell status
3. Run debug script: `node debug-balances.js`

### API Errors
1. Check request format
2. Verify transaction IDs exist
3. Check rate limiting 