import 'dotenv/config';

export const CONFIG = {
  // Wallet & RPC
  privateKey: process.env.PRIVATE_KEY || '',
  rpcUrl: process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',

  // Token mints (mainnet)
  tokens: {
    SOL: 'So11111111111111111111111111111111111111112',
    USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  },

  // Strategy params
  buyDipPercent: parseFloat(process.env.BUY_DIP_PERCENT || '0.3'),
  takeProfitPercent: parseFloat(process.env.TAKE_PROFIT_PERCENT || '0.8'),
  stopLossPercent: parseFloat(process.env.STOP_LOSS_PERCENT || '2.0'),
  maxPositionSizePercent: parseFloat(process.env.MAX_POSITION_SIZE_PERCENT || '30'),
  maxDailyLossPercent: parseFloat(process.env.MAX_DAILY_LOSS_PERCENT || '5'),

  // Execution
  slippageBps: parseInt(process.env.SLIPPAGE_BPS || '50'),
  priorityFeeLamports: parseInt(process.env.PRIORITY_FEE_LAMPORTS || '10000'),
  pollIntervalMs: 1000, // Check price every 1s
  cooldownAfterTradeMs: 3000, // Wait 3s between trades

  // Safety
  dryRun: process.env.DRY_RUN === 'true',
  maxConcurrentPositions: 1, // Keep it simple for $10
  minTradeAmountLamports: 10_000_000, // 0.01 SOL minimum trade
} as const;
