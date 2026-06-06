/**
 * SOL Arbitrage Bot — AI Arbitrage Trading System v3.0
 * Strategy: Multi-tier circular arb — stable pairs (large) + low-liquidity tokens (small/frequent)
 *
 * Capital scaling approach:
 *  - Stable routes  (USDC/USDT)  → 70% of balance, tight slippage, $0.20 min profit
 *  - Volatile routes (WIF/BONK/JUP/RAY/POPCAT) → 10-20% each, wider slippage, $0.10+ target
 *  - Triangular routes (SOL→TOKEN→USDC→SOL) → 3-hop, 10% size, captures cross-pool spreads
 *
 * Low-liquidity logic:
 *  - Small trade sizes prevent market impact slippage
 *  - Higher slippage tolerance lets trades fill on thin pools
 *  - More daily trades cap (10 vs 3) to compound small wins
 *  - Per-route profit & size config so volatile trades don't blow out on one bad fill
 */
import 'dotenv/config';
import { Connection, Keypair, LAMPORTS_PER_SOL, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';

// ─── Config ──────────────────────────────────────────────────────
const CFG = {
  privateKey:           process.env.PRIVATE_KEY || '',
  rpcUrl:               process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
  dryRun:               process.env.DRY_RUN !== 'false',
  maxDailyTrades:       parseInt(process.env.MAX_DAILY_TRADES || '10'),  // ↑ from 3 → 10 (more small trades)
  maxDailyLossPct:      parseFloat(process.env.MAX_DAILY_LOSS_PCT || '5'),
  priorityFeeLamports:  parseInt(process.env.PRIORITY_FEE_LAMPORTS || '10000'),
  scanIntervalMs:       4_000,   // 4 s scan (slightly faster)
  minBalanceLamports:   10_000_000, // 0.01 SOL floor
};

// ─── Token addresses ─────────────────────────────────────────────
const T = {
  SOL:    'So11111111111111111111111111111111111111112',
  USDC:   'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT:   'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  BONK:   'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  WIF:    'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', // dogwifhat
  JUP:    'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',  // Jupiter
  RAY:    '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',  // Raydium
  POPCAT: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr',
  PYTH:   'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3',
};

// ─── Route definitions ────────────────────────────────────────────
// tier: 'stable' | 'volatile' | 'triangular'
// tradePct: % of current balance to use for this route (prevents over-sizing on thin pools)
// slippageBps: max slippage tolerance (higher for thin pools)
// minProfitUsd: threshold before executing
interface RouteConfig {
  name:         string;
  hops:         string[];
  tradePct:     number;
  slippageBps:  number;
  minProfitUsd: number;
  tier:         'stable' | 'volatile' | 'triangular';
}

const ROUTES: RouteConfig[] = [
  // ── Stable pairs (large size, tight slippage) ──
  // High liquidity = low slippage, reliable fills, consistent $0.20 target
  { name: 'SOL→USDC→SOL',  hops: [T.SOL, T.USDC, T.SOL],  tradePct: 70, slippageBps: 50,  minProfitUsd: 0.20, tier: 'stable'    },
  { name: 'SOL→USDT→SOL',  hops: [T.SOL, T.USDT, T.SOL],  tradePct: 70, slippageBps: 50,  minProfitUsd: 0.20, tier: 'stable'    },

  // ── Volatile / low-liquidity routes (small size, wider slippage) ──
  // Thin pools → bigger spreads → more arb opportunities; cap size to avoid market impact
  { name: 'SOL→BONK→SOL',   hops: [T.SOL, T.BONK, T.SOL],   tradePct: 15, slippageBps: 150, minProfitUsd: 0.10, tier: 'volatile'  },
  { name: 'SOL→WIF→SOL',    hops: [T.SOL, T.WIF,  T.SOL],    tradePct: 15, slippageBps: 150, minProfitUsd: 0.10, tier: 'volatile'  },
  { name: 'SOL→JUP→SOL',    hops: [T.SOL, T.JUP,  T.SOL],    tradePct: 20, slippageBps: 100, minProfitUsd: 0.12, tier: 'volatile'  },
  { name: 'SOL→RAY→SOL',    hops: [T.SOL, T.RAY,  T.SOL],    tradePct: 20, slippageBps: 100, minProfitUsd: 0.12, tier: 'volatile'  },
  { name: 'SOL→POPCAT→SOL', hops: [T.SOL, T.POPCAT, T.SOL],  tradePct: 10, slippageBps: 200, minProfitUsd: 0.10, tier: 'volatile'  },
  { name: 'SOL→PYTH→SOL',   hops: [T.SOL, T.PYTH, T.SOL],    tradePct: 15, slippageBps: 150, minProfitUsd: 0.10, tier: 'volatile'  },

  // ── Triangular routes (3-hop: captures cross-pool spread) ──
  // SOL→MEME→USDC→SOL exploits mismatch between meme/USDC pool and USDC/SOL pool
  { name: 'SOL→BONK→USDC→SOL', hops: [T.SOL, T.BONK, T.USDC, T.SOL], tradePct: 10, slippageBps: 200, minProfitUsd: 0.20, tier: 'triangular' },
  { name: 'SOL→WIF→USDC→SOL',  hops: [T.SOL, T.WIF,  T.USDC, T.SOL], tradePct: 10, slippageBps: 200, minProfitUsd: 0.20, tier: 'triangular' },
  { name: 'SOL→JUP→USDC→SOL',  hops: [T.SOL, T.JUP,  T.USDC, T.SOL], tradePct: 12, slippageBps: 150, minProfitUsd: 0.20, tier: 'triangular' },
  { name: 'SOL→RAY→USDC→SOL',  hops: [T.SOL, T.RAY,  T.USDC, T.SOL], tradePct: 12, slippageBps: 150, minProfitUsd: 0.20, tier: 'triangular' },
];

// ─── State ───────────────────────────────────────────────────────
let dailyTrades    = 0;
let dailyPnlSol    = 0;
let totalProfitSol = 0;
let dayStart       = Date.now();
let solPrice       = 0;
const routeStats: Record<string, { trades: number; profitSol: number }> = {};
ROUTES.forEach(r => { routeStats[r.name] = { trades: 0, profitSol: 0 }; });

// ─── Jupiter helpers ─────────────────────────────────────────────
async function jupiterQuote(
  inputMint: string, outputMint: string, amountLamports: number, slippageBps: number
): Promise<any | null> {
  try {
    const url = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}` +
      `&amount=${amountLamports}&slippageBps=${slippageBps}&onlyDirectRoutes=false`;
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

async function fetchSolPrice(): Promise<number> {
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    const d = await r.json() as any;
    return d?.solana?.usd || solPrice;
  } catch { return solPrice; }
}

// ─── Scan one route for arb opportunity ──────────────────────────
interface ArbOpportunity {
  route:         RouteConfig;
  inputLamports: number;
  profitLamports: number;
  profitUsd:     number;
  quotes:        any[];  // one per hop pair
}

async function scanRoute(route: RouteConfig, balanceLamports: number): Promise<ArbOpportunity | null> {
  // Size trade as a % of balance; never exceed 95% (leave gas buffer)
  const tradeLamports = Math.max(
    Math.floor(balanceLamports * (route.tradePct / 100)),
    CFG.minBalanceLamports
  );
  if (tradeLamports > balanceLamports * 0.95) return null;

  // Estimate fees: ~20_000 base + priority × (hops-1)
  const numSwaps = route.hops.length - 1;
  const estFeeLamports = 20_000 * numSwaps + CFG.priorityFeeLamports * numSwaps;

  // Chain quotes through all hops
  const quotes: any[] = [];
  let amount = tradeLamports;
  for (let i = 0; i < route.hops.length - 1; i++) {
    const q = await jupiterQuote(route.hops[i], route.hops[i + 1], amount, route.slippageBps);
    if (!q) return null;
    quotes.push(q);
    amount = parseInt(q.outAmount);
  }

  const outLamports    = amount;
  const profitLamports = outLamports - tradeLamports - estFeeLamports;
  if (profitLamports <= 0) return null;

  const profitUsd = (profitLamports / LAMPORTS_PER_SOL) * solPrice;
  if (profitUsd < route.minProfitUsd) {
    // Sub-threshold: log quietly (shows the market is close to arb — good signal)
    console.log(`  [${route.tier}] ${route.name}: +$${profitUsd.toFixed(4)} (min $${route.minProfitUsd})`);
    return null;
  }

  return { route, inputLamports: tradeLamports, profitLamports, profitUsd, quotes };
}

// ─── Scan all routes, return best opportunity ─────────────────────
async function scanAllRoutes(balanceLamports: number): Promise<ArbOpportunity | null> {
  let best: ArbOpportunity | null = null;

  for (const route of ROUTES) {
    const opp = await scanRoute(route, balanceLamports);
    if (opp && (!best || opp.profitUsd > best.profitUsd)) {
      best = opp;
    }
  }
  return best;
}

// ─── Execute multi-hop trade ──────────────────────────────────────
async function executeTrade(opp: ArbOpportunity, wallet: Keypair, connection: Connection): Promise<boolean> {
  const hops = opp.route.hops;
  for (let i = 0; i < opp.quotes.length; i++) {
    const label = `${hops[i].slice(0, 4)}→${hops[i + 1].slice(0, 4)}`;
    console.log(`   🚀 Leg ${i + 1}/${opp.quotes.length}: ${label}...`);
    const sig = await jupiterSwap(opp.quotes[i], wallet, connection);
    if (!sig) {
      console.log(`   ❌ Leg ${i + 1} failed — stopping trade`);
      if (i > 0) console.log(`   ⚠️  Partial fill: you may hold intermediate token. Check wallet.`);
      return false;
    }
    console.log(`   ✅ Leg ${i + 1}: https://solscan.io/tx/${sig}`);
    if (i < opp.quotes.length - 1) await sleep(1500);
  }
  return true;
}

// ─── Daily counter reset ──────────────────────────────────────────
function resetDailyIfNeeded() {
  if (Date.now() - dayStart >= 24 * 60 * 60 * 1000) {
    dailyTrades = 0; dailyPnlSol = 0; dayStart = Date.now();
    console.log('\n🔄 Daily counters reset\n');
  }
}

// ─── Main ─────────────────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║   AI Arbitrage Bot v3.0 — Low-Liq Capital Scaling   ║');
  console.log('║   Strategy: Multi-tier Cross-DEX Circular Arb       ║');
  console.log(`║   Mode: ${CFG.dryRun ? 'DRY RUN 🧪                              ' : 'LIVE 🔴                                 '}║`);
  console.log('╚══════════════════════════════════════════════════════╝');

  if (!CFG.privateKey) { console.error('\n❌ Set PRIVATE_KEY in .env\n'); process.exit(1); }

  const wallet     = Keypair.fromSecretKey(bs58.decode(CFG.privateKey));
  const connection = new Connection(CFG.rpcUrl, 'confirmed');
  solPrice         = await fetchSolPrice();

  console.log(`\n🔑 Wallet: ${wallet.publicKey.toBase58()}`);

  const balance    = await connection.getBalance(wallet.publicKey);
  const balanceSol = balance / LAMPORTS_PER_SOL;
  console.log(`💰 Balance: ${balanceSol.toFixed(4)} SOL (~$${(balanceSol * solPrice).toFixed(2)} USD)`);
  console.log(`💵 SOL: $${solPrice.toFixed(2)}`);

  if (balance < CFG.minBalanceLamports) {
    console.error('\n❌ Balance too low. Fund wallet with at least 0.01 SOL.\n');
    process.exit(1);
  }

  console.log(`\n⚙️  Routes loaded: ${ROUTES.length} (${ROUTES.filter(r=>r.tier==='stable').length} stable, ` +
    `${ROUTES.filter(r=>r.tier==='volatile').length} volatile, ${ROUTES.filter(r=>r.tier==='triangular').length} triangular)`);
  console.log(`   Daily trade cap: ${CFG.maxDailyTrades} | Loss limit: ${CFG.maxDailyLossPct}%`);
  console.log('\n   Tier breakdown:');
  console.log('   [stable]     70% balance, 50 bps slip, $0.20 profit target');
  console.log('   [volatile]   10-20% balance, 100-200 bps slip, $0.10 target');
  console.log('   [triangular] 10-12% balance, 150-200 bps slip, $0.20 target');
  console.log('\n🔍 Scanning all routes...\n');

  let scanCount      = 0;
  let lastPriceRefresh = 0;

  while (true) {
    resetDailyIfNeeded();

    if (dailyTrades >= CFG.maxDailyTrades) {
      const hoursLeft = Math.ceil((dayStart + 86_400_000 - Date.now()) / 3_600_000);
      if (scanCount % 150 === 0)
        console.log(`⏸️  Daily cap hit (${dailyTrades}/${CFG.maxDailyTrades}). Resets in ~${hoursLeft}h`);
      await sleep(CFG.scanIntervalMs);
      scanCount++;
      continue;
    }

    // Refresh SOL price every 60 s
    if (Date.now() - lastPriceRefresh > 60_000) {
      solPrice = await fetchSolPrice();
      lastPriceRefresh = Date.now();
    }

    const currentBalance = await connection.getBalance(wallet.publicKey);

    // Daily loss circuit-breaker
    const maxLossSol = (currentBalance / LAMPORTS_PER_SOL) * (CFG.maxDailyLossPct / 100);
    if (dailyPnlSol < -maxLossSol) {
      if (scanCount % 60 === 0)
        console.log(`🛑 Daily loss limit hit (${dailyPnlSol.toFixed(4)} SOL). Pausing until reset.`);
      await sleep(CFG.scanIntervalMs);
      scanCount++;
      continue;
    }

    const opp = await scanAllRoutes(currentBalance);

    if (opp) {
      const profitSol = opp.profitLamports / LAMPORTS_PER_SOL;
      const sizeSol   = opp.inputLamports / LAMPORTS_PER_SOL;

      console.log(`\n💡 ARB FOUND [${opp.route.tier.toUpperCase()}] — ${opp.route.name}`);
      console.log(`   Size:   ${sizeSol.toFixed(4)} SOL  (${opp.route.tradePct}% of balance)`);
      console.log(`   Profit: +${profitSol.toFixed(6)} SOL  (~+$${opp.profitUsd.toFixed(4)} USD)`);
      console.log(`   Trades: ${dailyTrades + 1}/${CFG.maxDailyTrades}`);

      if (CFG.dryRun) {
        console.log(`   [DRY RUN] ✅ Would execute — +$${opp.profitUsd.toFixed(4)}`);
        dailyTrades++;
        dailyPnlSol    += profitSol;
        totalProfitSol += profitSol;
        routeStats[opp.route.name].trades++;
        routeStats[opp.route.name].profitSol += profitSol;
      } else {
        const ok = await executeTrade(opp, wallet, connection);
        if (ok) {
          dailyTrades++;
          dailyPnlSol    += profitSol;
          totalProfitSol += profitSol;
          routeStats[opp.route.name].trades++;
          routeStats[opp.route.name].profitSol += profitSol;
          console.log(`   🎯 Done! +$${opp.profitUsd.toFixed(4)} | Day PnL: $${(dailyPnlSol * solPrice).toFixed(4)}`);
        }
      }
      await sleep(8_000); // 8 s cooldown after any trade
    }

    // Status every 5 min
    if (scanCount > 0 && scanCount % 75 === 0) {
      const bal = await connection.getBalance(wallet.publicKey);
      console.log(`\n📊 Status | Trades: ${dailyTrades}/${CFG.maxDailyTrades} | ` +
        `Day PnL: $${(dailyPnlSol * solPrice).toFixed(4)} | ` +
        `Total: $${(totalProfitSol * solPrice).toFixed(4)} | ` +
        `Bal: ${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL ($${(bal / LAMPORTS_PER_SOL * solPrice).toFixed(2)})`);

      // Show per-route stats
      const activeRoutes = Object.entries(routeStats).filter(([,v]) => v.trades > 0);
      if (activeRoutes.length > 0) {
        console.log('   Route breakdown:');
        activeRoutes.forEach(([name, s]) => {
          console.log(`   ${name}: ${s.trades} trades, +$${(s.profitSol * solPrice).toFixed(4)}`);
        });
      }
    }

    scanCount++;
    await sleep(CFG.scanIntervalMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

main().catch(console.error);
