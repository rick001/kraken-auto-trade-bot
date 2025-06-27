# Kraken Auto-Trade Bot API Documentation

## Overview

The Kraken Auto-Trade Bot provides a unified service for managing automated cryptocurrency trading on Kraken. The service includes both REST API endpoints for querying trade details and real-time WebSocket connectivity for balance monitoring and automated selling.

**Base URL**: `http://localhost:3007` (configurable via `API_PORT` environment variable)

## Authentication

All API endpoints require valid Kraken API credentials configured via environment variables:
- `KRAKEN_API_KEY`: Your Kraken API key
- `KRAKEN_API_SECRET`: Your Kraken API secret

## Endpoints

### 1. Get Single Trade Details

Retrieve detailed information about a specific trade/order by its transaction ID.

**Endpoint**: `GET /api/trade/{txid}`

**Parameters**:
- `txid` (path, required): Transaction ID of the order

**Response**:
```json
{
  "orderId": "O2PMS2-VM6HC-5MQQOH",
  "status": "closed",
  "description": "sell 0.17729314 SOLUSD @ market",
  "volume": 0.17729314,
  "price": 141.09,
  "cost": 25.01429,
  "fee": 0.10006,
  "timestamp": "2025-06-27T06:19:25.477Z",
  "closeTime": "2025-06-27T06:19:28.489Z",
  "trades": [
    {
      "tradeId": "TZA4L6-SGPSP-HF3TFV",
      "pair": "SOLUSD",
      "type": "sell",
      "ordertype": "market",
      "price": 141.09,
      "cost": 25.01429,
      "fee": 0.10006,
      "volume": 0.17729314,
      "margin": "0.00000",
      "timestamp": "2025-06-27T06:19:28.885Z",
      "misc": ""
    }
  ]
}
```

**Error Responses**:
- `404`: Order not found
- `500`: Internal server error

**Example**:
```bash
curl http://localhost:3007/api/trade/O2PMS2-VM6HC-5MQQOH
```

### 2. Get Multiple Trade Details (Batch)

Retrieve details for multiple trades/orders in a single request.

**Endpoint**: `POST /api/trades/batch`

**Request Body**:
```json
{
  "txids": ["O2PMS2-VM6HC-5MQQOH", "ORMJND-5CYBJ-ZLBSJ5"]
}
```

**Response**:
```json
{
  "O2PMS2-VM6HC-5MQQOH": {
    "orderId": "O2PMS2-VM6HC-5MQQOH",
    "status": "closed",
    "description": "sell 0.17729314 SOLUSD @ market",
    "volume": 0.17729314,
    "price": 141.09,
    "cost": 25.01429,
    "fee": 0.10006,
    "timestamp": "2025-06-27T06:19:25.477Z",
    "closeTime": "2025-06-27T06:19:28.489Z",
    "trades": [...]
  },
  "ORMJND-5CYBJ-ZLBSJ5": {
    "orderId": "ORMJND-5CYBJ-ZLBSJ5",
    "status": "closed",
    "description": "sell 0.52571 TRUMPUSD @ market",
    "volume": 0.52571,
    "price": 8.987,
    "cost": 4.72508,
    "fee": 0.01890,
    "timestamp": "2025-06-27T06:19:29.637Z",
    "closeTime": "2025-06-27T06:19:32.347Z",
    "trades": [...]
  }
}
```

**Error Responses**:
- `400`: Invalid request (missing txids, empty array, or too many txids)
- `500`: Internal server error

**Limitations**:
- Maximum 20 transaction IDs per request

**Example**:
```bash
curl -X POST http://localhost:3007/api/trades/batch \
  -H "Content-Type: application/json" \
  -d '{"txids": ["O2PMS2-VM6HC-5MQQOH", "ORMJND-5CYBJ-ZLBSJ5"]}'
```

### 3. Auto-Sell Service Status

Get the current status of the auto-sell service, including balance information and WebSocket connectivity.

**Endpoint**: `GET /api/auto-sell/status`

**Response**:
```json
{
  "status": "running",
  "timestamp": "2025-06-27T06:19:44.881Z",
  "initialProcessingComplete": true,
  "currentBalances": {
    "SOL": "0",
    "TRUMP": "0",
    "USDC": "0",
    "USDT": "0",
    "XETH": "0",
    "XXBT": "0",
    "XXDG": "12.00427438",
    "ZUSD": "181.9629"
  },
  "websocket": {
    "connected": true,
    "lastUpdate": "2025-06-27T06:19:44.881Z"
  }
}
```

**Example**:
```bash
curl http://localhost:3007/api/auto-sell/status
```

### 4. Health Check

Check the overall health and status of the service.

**Endpoint**: `GET /api/health`

**Response**:
```json
{
  "status": "ok",
  "timestamp": "2025-06-27T06:19:44.881Z",
  "environment": "development",
  "kraken": {
    "sandbox": false,
    "endpoints": {
      "REST": "https://api.kraken.com/0",
      "WS": "wss://ws-auth.kraken.com"
    }
  },
  "services": {
    "api": "running",
    "autoSell": "running"
  }
}
```

**Example**:
```bash
curl http://localhost:3007/api/health
```

### 5. API Documentation (Swagger UI)

Interactive API documentation and testing interface.

**Endpoint**: `GET /api/docs`

**Description**: Provides a web-based interface for exploring and testing all API endpoints.

**Example**:
```bash
# Open in browser
http://localhost:3007/api/docs
```

### 6. OpenAPI Specification

Get the OpenAPI specification in JSON format.

**Endpoint**: `GET /api/openapi.json`

**Example**:
```bash
curl http://localhost:3007/api/openapi.json
```

## Auto-Sell Service Features

### Balance Monitoring

The service automatically monitors your Kraken account balances via WebSocket connection and:

1. **Initial Processing**: On startup, processes all existing balances and sells non-fiat assets
2. **Real-time Updates**: Monitors for new balance changes and automatically sells new assets
3. **Minimum Order Validation**: Only sells assets that meet minimum order size requirements
4. **Fiat Currency Handling**: Skips selling of target fiat currency (default: ZUSD)

### Supported Assets

The service supports all tradable assets on Kraken, including:
- Cryptocurrencies: BTC, ETH, SOL, DOGE, etc.
- Stablecoins: USDC, USDT, etc.
- Fiat: USD (ZUSD)

### Configuration

The service can be configured via environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `API_PORT` | Port for the REST API | `3000` |
| `KRAKEN_API_KEY` | Kraken API key | Required |
| `KRAKEN_API_SECRET` | Kraken API secret | Required |
| `KRAKEN_SANDBOX` | Use Kraken sandbox | `false` |
| `TARGET_FIAT` | Target fiat currency | `ZUSD` |
| `NODE_ENV` | Environment | `development` |
| `LOG_API_ENABLED` | Enable external logging | `false` |
| `LOG_API_ENDPOINT` | External logging endpoint | `""` |
| `LOG_API_KEY` | External logging API key | `""` |

## Error Handling

### Common Error Codes

- `400`: Bad Request - Invalid parameters or request format
- `404`: Not Found - Resource not found
- `500`: Internal Server Error - Server-side error

### Error Response Format

```json
{
  "error": "Error type",
  "message": "Detailed error message"
}
```

## Rate Limiting

The API implements rate limiting to comply with Kraken's API restrictions:
- Maximum 15 requests per second
- Automatic retry with exponential backoff for transient errors
- Minimum 100ms delay between requests to prevent nonce conflicts

## WebSocket Connection

The service maintains a persistent WebSocket connection to Kraken for real-time balance updates:

- **Endpoint**: `wss://ws-auth.kraken.com` (production) or `wss://demo-futures.kraken.com/ws/v1` (sandbox)
- **Authentication**: Uses Kraken WebSocket token
- **Reconnection**: Automatic reconnection on connection loss
- **Heartbeat**: Regular ping/pong to maintain connection

## Logging

The service provides comprehensive logging:

- **Console Logging**: All operations logged to console with timestamps
- **External Logging**: Optional external API logging for monitoring
- **Log Levels**: ERROR, WARN, INFO, DEBUG
- **Structured Logs**: JSON-formatted log entries with metadata

## Security Considerations

1. **API Credentials**: Store API keys securely and never commit them to version control
2. **Network Security**: Use HTTPS in production environments
3. **Access Control**: Implement appropriate access controls for the API endpoints
4. **Rate Limiting**: Respect Kraken's API rate limits
5. **Sandbox Testing**: Use sandbox environment for testing

## Troubleshooting

### Common Issues

1. **WebSocket Disconnection**: Check network connectivity and API credentials
2. **Nonce Errors**: Service automatically handles nonce conflicts with retries
3. **Balance Not Detected**: Ensure WebSocket connection is established and check logs
4. **Order Failures**: Verify minimum order sizes and available balance

### Debug Mode

Enable debug logging by setting the environment variable:
```bash
set DEBUG=true
```

### Health Check

Use the health check endpoint to verify service status:
```bash
curl http://localhost:3007/api/health
```

## Examples

### Complete Workflow Example

1. **Start the service**:
   ```bash
   node kraken-service.js
   ```

2. **Check service health**:
   ```bash
   curl http://localhost:3007/api/health
   ```

3. **Monitor auto-sell status**:
   ```bash
   curl http://localhost:3007/api/auto-sell/status
   ```

4. **Query trade details**:
   ```bash
   curl http://localhost:3007/api/trade/O2PMS2-VM6HC-5MQQOH
   ```

5. **Batch query multiple trades**:
   ```bash
   curl -X POST http://localhost:3007/api/trades/batch \
     -H "Content-Type: application/json" \
     -d '{"txids": ["O2PMS2-VM6HC-5MQQOH", "ORMJND-5CYBJ-ZLBSJ5"]}'
   ```

## Support

For issues and questions:
1. Check the logs for detailed error information
2. Verify API credentials and network connectivity
3. Test with the debug script: `node debug-balances.js`
4. Review the health check endpoint for service status 