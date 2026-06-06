/**
 * SOL Arbitrage Bot — AI Arbitrage Trading System
 * Strategy: Circular DEX arbitrage on Solana via Jupiter
 *   SOL → USDC → SOL (+ triangular routes)
 * Specs: 3 trades/day cap, $0.20 target profit per trade
 */
import 'dotenv/config';
import { Connection, Keypair, LAMPORTS_PER_SOL, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';

// ─── Config ──────────────────────────────────────────────────────
const CFG = {
  privateKey:            process.env.PRIVATE_KEY || '',
  rpcUrl:                process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
  dryRun:                process.env.DRY_RUN !== 'false',   // default ON until user flips it
  maxDailyTrades:        parseInt(process.env.MAX_DAILY_TRADES || '3'),
  minProfitUsd:          parseFloat(process.env.MIN_PROFIT_USD || '0.20'),
  maxDailyLossPct:       parseFloat(process.env.MAX_DAILY_LOSS_PCT || '5'),
  tradeSizePct:          parseFloat(process.env.TRADE_SIZE_PCT || '80'), // % of balance per trade
  slippageBps:           parseInt(process.env.SLIPPAGE_BPS || '50'),
  priorityFeeLamports:   parseInt(process.env.PRIORITY_FEE_LAMPORTS || '10000'),
  scanIntervalMs:        5_000,  // scan every 5 s
  minTradeAmountLamports: 10_000_000, // 0.01 SOL min

  tokens: {
    SOL:  'So11111111111111111111111111111111111111112',
    USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  },
};

// ─── State ───────────────────────────────────────────────────────
let dailyTrades   = 0;
let dailyPnlSol   = 0;
let totalProfitSol = 0;
let dayStart      = Date.now();
let solPrice      = 0; // USD price of SOL (fetched once per minute)

// ─── Jupiter helpers ─────────────────────────────────────────────
async function jupiterQuote(
  inputMint: string, outputMint: string, amountLamports: number
): Promise<any | null> {
  try {
    const url = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}` +
      `&amount=${amountLamports}&slippageBps=${CFG.slippageBps}&onlyDirectRoutes=false`;
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function jupiterSwap(quote: any, wallet: Keypair, connection: Connection): Promise<string | null> {
  try {
    const res = await fetch('https://quote-api.jup.ag/v6/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: CFG.priorityFeeLamports,
      }),
    });
    if (!res.ok) { console.error('[Jupiter] Swap API:', await res.text()); return null; }
    const { swapTransaction } = await res.json() as { swapTransaction: string };
    const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
    tx.sign([wallet]);
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
    const bh = await connection.getLatestBlockhash();
    await connection.confirmTransaction({ signature: sig, ...bh }, 'confirmed');
    return sig;
  } catch (e) { console.error('[Jupiter] Swap error:', e); return null; }
}

// ─── Fetch SOL price in USD (CoinGecko free) ─────────────────────
async function fetchSolPrice(): Promise<number> {
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    const d = await r.json() as any;
    return d?.solana?.usd || 0;
  } catch { return solPrice; }
}

// ─── Core: check circular arbitrage opportunity ───────────────────
interface ArbOpportunity {
  route: string;
  inputLamports: number;
  outputLamports: number;
  profitLamports: number;
  profitUsd: number;
  quote1: any;
  quote2?: any;
}

async function scanArbitrage(balance: number): Promise<ArbOpportunity | null> {
  const tradeLamports = Math.max(
    Math.floor(balance * (CFG.tradeSizePct / 100)),
    CFG.minTradeAmountLamports
  );
  if (tradeLamports > balance * 0.95) return null; // safety: leave 5% for fees

  // Estimate tx fees: ~0.00001 SOL × 2 swaps = 20_000 lamports
  const estFeeLamports = 20_000 + CFG.priorityFeeLamports * 2;

  const routes = [
    { name: 'SOL→USDC→SOL',  hops: [CFG.tokens.SOL,  CFG.tokens.USDC, CFG.tokens.SOL] },
    { name: 'SOL→USDT→SOL',  hops: [CFG.tokens.SOL,  CFG.tokens.USDT, CFG.tokens.SOL] },
    { name: 'SOL→BONK→SOL',  hops: [CFG.tokens.SOL,  CFG.tokens.BONK, CFG.tokens.SOL] },
  ];

  for (const route of routes) {
    const [tok0, tok1, tok2] = route.hops;
    const q1 = await jupiterQuote(tok0, tok1, tradeLamports);
    if (!q1) continue;
    const midAmount = parseInt(q1.outAmount);
    const q2 = await jupiterQuote(tok1, tok2, midAmount);
    if (!q2) continue;
    const outLamports = parseInt(q2.outAmount);
    const profitLamports = outLamports - tradeLamports - estFeeLamports;

    if (profitLamports <= 0) continue;

    const profitUsd = (profitLamports / LAMPORTS_PER_SOL) * solPrice;
    if (profitUsd < CFG.minProfitUsd) {
      // Opportunity exists but below threshold — log it
      console.log(`  📊 ${route.name}: +${profitUsd.toFixed(4)} USD (below $${CFG.minProfitUsd} threshold)`);
      continue;
    }

    return { route: route.name, inputLamports: tradeLamports, outputLamports: outLamports, profitLamports, profitUsd, quote1: q1, quote2: q2 };
  }
  return null;
}

// ─── Reset daily counters ─────────────────────────────────────────
function resetDailyIfNeeded() {
  if (Date.now() - dayStart >= 24 * 60 * 60 * 1000) {
    dailyTrades = 0; dailyPnlSol = 0; dayStart = Date.now();
    console.log('\n🔄 Daily counters reset\n');
  }
}

// ─── Main ─────────────────────────────────────────────────────────
async function main() {
  console.log('╔════════════════════════════════════════════╗');
  console.log('║   AI Arbitrage Bot v2.0                    ║');
  console.log('║   Strategy: Cross-DEX Circular Arbitrage   ║');
  console.log(`║   Mode: ${CFG.dryRun ? 'DRY RUN 🧪              ' : 'LIVE 🔴                 '}║`);
  console.log('╚════════════════════════════════════════════╝');

  if (!CFG.privateKey) { console.error('\n❌ Set PRIVATE_KEY in .env\n'); process.exit(1); }

  const wallet     = Keypair.fromSecretKey(bs58.decode(CFG.privateKey));
  const connection = new Connection(CFG.rpcUrl, 'confirmed');

  console.log(`\n🔑 Wallet: ${wallet.publicKey.toBase58()}`);

  const balance = await connection.getBalance(wallet.publicKey);
  solPrice = await fetchSolPrice();

  const balanceSol = balance / LAMPORTS_PER_SOL;
  const balanceUsd = balanceSol * solPrice;
  console.log(`💰 Balance: ${balanceSol.toFixed(4)} SOL (~$${balanceUsd.toFixed(2)} USD)`);
  console.log(`💵 SOL Price: $${solPrice.toFixed(2)}`);

  if (balance < CFG.minTradeAmountLamports) {
    console.error('\n❌ Balance too low. Fund wallet with at least 0.01 SOL.\n');
    process.exit(1);
  }

  console.log(`\n⚙️  Strategy:`);
  console.log(`   Daily trade cap: ${CFG.maxDailyTrades} trades`);
  console.log(`   Min profit/trade: $${CFG.minProfitUsd}`);
  console.log(`   Trade size: ${CFG.tradeSizePct}% of balance`);
  console.log(`   Daily loss limit: ${CFG.maxDailyLossPct}% of balance`);
  console.log(`   Slippage: ${CFG.slippageBps} bps`);
  console.log(`\n🔍 Scanning for arbitrage opportunities...\n`);

  let scanCount = 0;
  let lastPriceRefresh = 0;

  while (true) {
    resetDailyIfNeeded();

    if (dailyTrades >= CFG.maxDailyTrades) {
      const hoursLeft = Math.ceil((dayStart + 86_400_000 - Date.now()) / 3_600_000);
      if (scanCount % 120 === 0) // Log every 10 min
        console.log(`⏸️  Daily trade limit reached (${dailyTrades}/${CFG.maxDailyTrades}). Resets in ~${hoursLeft}h`);
      await sleep(CFG.scanIntervalMs);
      scanCount++;
      continue;
    }

    // Refresh SOL price every 60 s
    if (Date.now() - lastPriceRefresh > 60_000) {
      solPrice = await fetchSolPrice();
      lastPriceRefresh = Date.now();
    }

    // Check daily loss limit
    const currentBalance = await connection.getBalance(wallet.publicKey);
    const maxDailyLossSol = (currentBalance / LAMPORTS_PER_SOL) * (CFG.maxDailyLossPct / 100);
    if (dailyPnlSol < -maxDailyLossSol) {
      if (scanCount % 60 === 0)
        console.log(`🛑 Daily loss limit hit: ${dailyPnlSol.toFixed(6)} SOL. Pausing until reset.`);
      await sleep(CFG.scanIntervalMs);
      scanCount++;
      continue;
    }

    const opp = await scanArbitrage(currentBalance);

    if (opp) {
      const profitSol = opp.profitLamports / LAMPORTS_PER_SOL;
      console.log(`\n💡 ARB FOUND — ${opp.route}`);
      console.log(`   Input:  ${(opp.inputLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
      console.log(`   Output: ${(opp.outputLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
      console.log(`   Profit: +${profitSol.toFixed(6)} SOL (~+$${opp.profitUsd.toFixed(4)} USD)`);
      console.log(`   Trades today: ${dailyTrades + 1}/${CFG.maxDailyTrades}`);

      if (CFG.dryRun) {
        console.log(`   [DRY RUN] ✅ Would execute — profit +$${opp.profitUsd.toFixed(4)}`);
        dailyTrades++;
        dailyPnlSol += profitSol;
        totalProfitSol += profitSol;
      } else {
        console.log(`   🚀 Executing leg 1: ${opp.route.split('→').slice(0, 2).join('→')}...`);
        const sig1 = await jupiterSwap(opp.quote1, wallet, connection);
        if (!sig1) { console.log(`   ❌ Leg 1 failed, skipping`); await sleep(5000); continue; }
        console.log(`   ✅ Leg 1: https://solscan.io/tx/${sig1}`);

        await sleep(1500); // brief pause between legs
        console.log(`   🚀 Executing leg 2: ${opp.route.split('→').slice(1).join('→')}...`);
        const sig2 = await jupiterSwap(opp.quote2, wallet, connection);
        if (!sig2) { console.log(`   ⚠️  Leg 2 failed — you may hold intermediate token`); }
        else {
          console.log(`   ✅ Leg 2: https://solscan.io/tx/${sig2}`);
          dailyTrades++;
          dailyPnlSol += profitSol;
          totalProfitSol += profitSol;
          console.log(`   🎯 Arb complete! +$${opp.profitUsd.toFixed(4)} | Daily PnL: ${(dailyPnlSol * solPrice).toFixed(4)} USD`);
        }
      }
      await sleep(10_000); // 10 s cooldown after trade
    }

    // Periodic status
    if (scanCount > 0 && scanCount % 60 === 0) {
      const bal = await connection.getBalance(wallet.publicKey);
      console.log(`\n📊 Status | Trades: ${dailyTrades}/${CFG.maxDailyTrades} | Daily PnL: $${(dailyPnlSol * solPrice).toFixed(4)} | Total: $${(totalProfitSol * solPrice).toFixed(4)} | Balance: ${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL ($${(bal / LAMPORTS_PER_SOL * solPrice).toFixed(2)})`);
    }

    scanCount++;
    await sleep(CFG.scanIntervalMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

main().catch(console.error);
