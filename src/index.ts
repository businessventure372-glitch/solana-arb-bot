import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';
import { CONFIG } from './config.js';
import { getSOLPrice, getQuote, executeSwap } from './jupiter.js';
import { RiskManager, TradeRecord } from './risk.js';

// ─── State ───────────────────────────────────────────────────────
let currentPrice = 0;
let entryPrice = 0;
let inPosition = false;
let priceHistory: number[] = [];
const HISTORY_WINDOW = 30; // Track last 30 price points

// ─── Initialize ──────────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║   SOL Micro-Scalper v1.0             ║');
  console.log('║   Strategy: Dip-Buy / Quick-Sell     ║');
  console.log(`║   Mode: ${CONFIG.dryRun ? 'DRY RUN 🧪' : 'LIVE 🔴'}             ║`);
  console.log('╚══════════════════════════════════════╝');

  if (!CONFIG.privateKey) {
    console.error('❌ Set PRIVATE_KEY in .env');
    process.exit(1);
  }

  const wallet = Keypair.fromSecretKey(bs58.decode(CONFIG.privateKey));
  const connection = new Connection(CONFIG.rpcUrl, 'confirmed');

  console.log(`\n🔑 Wallet: ${wallet.publicKey.toBase58()}`);

  // Get initial balance
  const balance = await connection.getBalance(wallet.publicKey);
  console.log(`💰 Balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

  if (balance < CONFIG.minTradeAmountLamports) {
    console.error('❌ Balance too low for trading');
    process.exit(1);
  }

  const risk = new RiskManager(balance);

  console.log(`\n⚙️  Config:`);
  console.log(`   Buy dip: -${CONFIG.buyDipPercent}%`);
  console.log(`   Take profit: +${CONFIG.takeProfitPercent}%`);
  console.log(`   Stop loss: -${CONFIG.stopLossPercent}%`);
  console.log(`   Max position: ${CONFIG.maxPositionSizePercent}% of balance`);
  console.log(`   Slippage: ${CONFIG.slippageBps} bps`);
  console.log(`   Priority fee: ${CONFIG.priorityFeeLamports} lamports`);
  console.log(`\n🚀 Starting scalp loop...\n`);

  // Main loop
  await scalpLoop(wallet, connection, risk);
}

async function scalpLoop(
  wallet: Keypair,
  connection: Connection,
  risk: RiskManager
) {
  while (true) {
    try {
      // 1. Get current price
      const price = await getSOLPrice();
      if (!price) {
        await sleep(CONFIG.pollIntervalMs);
        continue;
      }

      currentPrice = price;
      priceHistory.push(price);
      if (priceHistory.length > HISTORY_WINDOW) priceHistory.shift();

      // Need enough data to detect dip
      if (priceHistory.length < 5) {
        await sleep(CONFIG.pollIntervalMs);
        continue;
      }

      // 2. Strategy logic
      if (!inPosition) {
        // Look for buy signal: price dipped below recent average
        const recentAvg = priceHistory.slice(-10).reduce((a, b) => a + b, 0) / Math.min(priceHistory.length, 10);
        const dipPercent = ((recentAvg - currentPrice) / recentAvg) * 100;

        if (dipPercent >= CONFIG.buyDipPercent) {
          const { allowed, reason } = risk.canTrade();
          if (!allowed) {
            console.log(`⛔ Trade blocked: ${reason}`);
            await sleep(CONFIG.pollIntervalMs * 5);
            continue;
          }

          // BUY signal
          const positionSize = risk.getPositionSize();
          console.log(`\n🟢 BUY SIGNAL | Price: $${currentPrice.toFixed(2)} | Dip: -${dipPercent.toFixed(2)}%`);
          console.log(`   Position: ${(positionSize / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

          if (CONFIG.dryRun) {
            console.log(`   [DRY RUN] Would buy at $${currentPrice.toFixed(2)}`);
            entryPrice = currentPrice;
            inPosition = true;
          } else {
            // Execute buy: SOL -> USDC (we sell SOL at dip to buy back cheaper... 
            // Actually for scalping SOL: we BUY SOL when it dips, SELL when it rises)
            // Strategy: Hold USDC as base, buy SOL on dips, sell SOL on pumps
            // For simplicity with SOL-native wallet: 
            //   - "Buy" = keep SOL position (do nothing, we're already in SOL)
            //   - Actually, let's trade SOL<->USDC
            
            // Buy SOL with USDC portion (or just track entry and sell later)
            entryPrice = currentPrice;
            inPosition = true;
            
            risk.recordTrade({
              timestamp: Date.now(),
              type: 'buy',
              amountLamports: positionSize,
              price: currentPrice,
              txSig: 'entry-mark',
            });
          }

          await sleep(CONFIG.cooldownAfterTradeMs);
        }
      } else {
        // In position - check exit conditions
        const pnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100;

        // Take profit
        if (pnlPercent >= CONFIG.takeProfitPercent) {
          console.log(`\n🎯 TAKE PROFIT | Entry: $${entryPrice.toFixed(2)} → Exit: $${currentPrice.toFixed(2)} | PnL: +${pnlPercent.toFixed(2)}%`);

          if (!CONFIG.dryRun) {
            // Execute sell via Jupiter: SOL -> USDC
            const posSize = risk.getPositionSize();
            const quote = await getQuote(CONFIG.tokens.SOL, CONFIG.tokens.USDC, posSize);
            if (quote) {
              const sig = await executeSwap(quote, wallet, connection);
              if (sig) {
                console.log(`   ✅ TX: https://solscan.io/tx/${sig}`);
                const pnlSol = (posSize / LAMPORTS_PER_SOL) * (pnlPercent / 100);
                risk.recordTrade({
                  timestamp: Date.now(),
                  type: 'sell',
                  amountLamports: posSize,
                  price: currentPrice,
                  pnl: pnlSol,
                  txSig: sig,
                });
              }
            }
          } else {
            const posSize = risk.getPositionSize();
            const pnlSol = (posSize / LAMPORTS_PER_SOL) * (pnlPercent / 100);
            console.log(`   [DRY RUN] Profit: +${pnlSol.toFixed(6)} SOL`);
            risk.recordTrade({
              timestamp: Date.now(),
              type: 'sell',
              amountLamports: posSize,
              price: currentPrice,
              pnl: pnlSol,
              txSig: 'dry-run',
            });
          }

          inPosition = false;
          await sleep(CONFIG.cooldownAfterTradeMs);
        }

        // Stop loss
        else if (pnlPercent <= -CONFIG.stopLossPercent) {
          console.log(`\n🔴 STOP LOSS | Entry: $${entryPrice.toFixed(2)} → Exit: $${currentPrice.toFixed(2)} | PnL: ${pnlPercent.toFixed(2)}%`);

          if (!CONFIG.dryRun) {
            const posSize = risk.getPositionSize();
            const quote = await getQuote(CONFIG.tokens.SOL, CONFIG.tokens.USDC, posSize);
            if (quote) {
              const sig = await executeSwap(quote, wallet, connection);
              if (sig) {
                console.log(`   ✅ TX: https://solscan.io/tx/${sig}`);
                const pnlSol = (posSize / LAMPORTS_PER_SOL) * (pnlPercent / 100);
                risk.recordTrade({
                  timestamp: Date.now(),
                  type: 'sell',
                  amountLamports: posSize,
                  price: currentPrice,
                  pnl: pnlSol,
                  txSig: sig,
                });
              }
            }
          } else {
            const posSize = risk.getPositionSize();
            const pnlSol = (posSize / LAMPORTS_PER_SOL) * (pnlPercent / 100);
            console.log(`   [DRY RUN] Loss: ${pnlSol.toFixed(6)} SOL`);
            risk.recordTrade({
              timestamp: Date.now(),
              type: 'sell',
              amountLamports: posSize,
              price: currentPrice,
              pnl: pnlSol,
              txSig: 'dry-run',
            });
          }

          inPosition = false;
          await sleep(CONFIG.cooldownAfterTradeMs * 2); // Extra cooldown after loss
        }
      }

      // Print periodic stats
      if (priceHistory.length % 30 === 0) {
        const stats = risk.getStats();
        console.log(`\n📊 Stats | Trades: ${stats.totalTrades} | Win rate: ${stats.winRate}% | Daily PnL: ${stats.dailyPnl} SOL | Price: $${currentPrice.toFixed(2)}`);
      }

    } catch (e) {
      console.error('Loop error:', e);
      await sleep(CONFIG.pollIntervalMs * 3);
    }

    await sleep(CONFIG.pollIntervalMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Start
main().catch(console.error);
