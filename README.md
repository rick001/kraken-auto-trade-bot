# Kraken Auto-Sell & Trade API Service

Auto-sell bot for Kraken – Converts crypto balances to USD using WebSocket & REST API with Swagger support.

## Features
- **Auto-sell**: Monitors your Kraken balances and automatically sells all assets to USD using the Kraken API.
- **Real-time**: Uses WebSocket for instant balance updates and REST API for order placement.
- **Trade/Order API**: Query trade and order details by transaction ID via REST endpoints.
- **Swagger/OpenAPI**: Interactive API documentation at `/api/docs`.
- **Health & Status**: Endpoints for service health and auto-sell status.
- **Modular**: All core logic is reusable and testable.

## Requirements
- Node.js 18+
- Kraken API credentials (with trading permissions)

## Setup
1. **Clone the repository:**
   ```bash
   git clone https://github.com/rick001/kraken-auto-trade-bot.git
   cd kraken-auto-trade-bot
   ```
2. **Install dependencies:**
   ```bash
   npm install
   ```
3. **Configure environment:**
   - Copy `.env.example` to `.env` and fill in your Kraken API credentials:
     ```
     KRAKEN_API_KEY=your_key
     KRAKEN_API_SECRET=your_secret
     # Optional: KRAKEN_SANDBOX=true for testnet
     ```

## Usage
- **Start the unified service (API + auto-sell):**
  ```bash
  npm start
  # or
  node kraken-service.js
  ```
- **Standalone auto-sell runner:**
  ```bash
  npm run balances
  # or
  node kraken-balances.js
  ```
- **Standalone trade API:**
  ```bash
  npm run trade-api
  # or
  node kraken-trade-api.js
  ```

## API Documentation
- **Swagger UI:** [http://localhost:3000/api/docs](http://localhost:3000/api/docs)
- **OpenAPI JSON:** [http://localhost:3000/api/openapi.json](http://localhost:3000/api/openapi.json)

### Main Endpoints
- `GET /api/trade/:txid` — Get details for a single trade/order by transaction ID
- `POST /api/trades/batch` — Get details for multiple trades/orders
- `GET /api/auto-sell/status` — Get status of the auto-sell service
- `GET /api/health` — Health check for the unified service

## Project Structure
```
kraken-service.js        # Unified API + auto-sell service
kraken-auto-sell.js      # Core auto-sell logic (reusable)
kraken-balances.js       # Standalone auto-sell runner
kraken-trade-api.js      # Standalone trade API
.env.example             # Example environment config
package.json             # Project metadata and dependencies
.gitignore               # Node, env, and log ignores
```

## License
MIT License © 2025 rick001 