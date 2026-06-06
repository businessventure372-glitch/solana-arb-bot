/**
 * SOL Arbitrage Bot — AI Arbitrage Trading System v3.1
 * ═══════════════════════════════════════════════════════
 * PRIORITY #1: CAPITAL SCALING
 * ─────────────────────────────
 * Scaling engine unlocks more capacity as balance grows:
 *
 *  Tier       Balance    Daily cap   Scan speed   Size mult
 *  ───────────────────────────────────────────────────────
 *  Seed       < 0.15 SOL     10       4 s          1.0×
 *  Growth     ≥ 0.15 SOL     15       3 s          1.1×
 *  Scale      ≥ 0.30 SOL     20       2.5 s        1.2×
 *  Turbo      ≥ 0.50 SOL     25       2 s          1.3×
 *  Hyper      ≥ 1.0 SOL      35       1.5 s        1.5×
 *
 * Compounding: every trade uses current balance as base →
 * profits auto-reinvest into next trade automatically.
 *
 * Milestones: bot logs when balance hits +10/25/50/100/200% growth.
 */
import 'dotenv/config';
import { Connection, Keypair, LAMPORTS_PER_SOL, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';

// ─── Static config (from env) ────────────────────────────────────
const CFG = {
  privateKey:          process.env.PRIVATE_KEY || '',
  rpcUrl:              process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
  dryRun:              process.env.DRY_RUN !== 'false',
  maxDailyLossPct:     parseFloat(process.env.MAX_DAILY_LOSS_PCT  || '5'),
  priorityFeeLamports: parseInt(process.env.PRIORITY_FEE_LAMPORTS || '10000'),
  minBalanceLamports:  10_000_000, // 0.01 SOL absolute floor
};

// ─── Scaling tier engine (PRIORITY #1) ───────────────────────────
interface ScalingTier {
  name:          string;
  minSol:        number;
  maxDailyTrades: number;
  scanIntervalMs: number;
  tradeMultiplier: number; // multiplies base tradePct for all routes
}

const TIERS: ScalingTier[] = [
  { name: 'Seed',   minSol: 0.00, maxDailyTrades: 10, scanIntervalMs: 4000, tradeMultiplier: 1.0 },
  { name: 'Growth', minSol: 0.15, maxDailyTrades: 15, scanIntervalMs: 3000, tradeMultiplier: 1.1 },
  { name: 'Scale',  minSol: 0.30, maxDailyTrades: 20, scanIntervalMs: 2500, tradeMultiplier: 1.2 },
  { name: 'Turbo',  minSol: 0.50, maxDailyTrades: 25, scanIntervalMs: 2000, tradeMultiplier: 1.3 },
  { name: 'Hyper',  minSol: 1.00, maxDailyTrades: 35, scanIntervalMs: 1500, tradeMultiplier: 1.5 },
];

function getTier(balanceSol: number): ScalingTier {
  // Walk backwards — return the highest tier the balance qualifies for
  for (let i = TIERS.length - 1; i >= 0; i--) {
    if (balanceSol >= TIERS[i].minSol) return TIERS[i];
  }
  return TIERS[0];
}

// Growth milestones to celebrate 🚀
const MILESTONES = [0.10, 0.25, 0.50, 1.00, 2.00, 5.00];

// ─── Token addresses ─────────────────────────────────────────────
const T = {
  SOL:    'So11111111111111111111111111111111111111112',
  USDC:   'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT:   'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  BONK:   'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  WIF:    'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
  JUP:    'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  RAY:    '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
  POPCAT: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr',
  PYTH:   'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3',
};

// ─── Route definitions ────────────────────────────────────────────
interface RouteConfig {
  name:          string;
  hops:          string[];
  baseTradePct:  number;  // base %; scaled up by tier.tradeMultiplier
  slippageBps:   number;
  minProfitUsd:  number;
  tier:          'stable' | 'volatile' | 'triangular';
}

const ROUTES: RouteConfig[] = [
  // Stable — large size, tight slippage
  { name: 'SOL→USDC→SOL',       hops: [T.SOL, T.USDC, T.SOL],              baseTradePct: 70, slippageBps: 50,  minProfitUsd: 0.20, tier: 'stable'     },
  { name: 'SOL→USDT→SOL',       hops: [T.SOL, T.USDT, T.SOL],              baseTradePct: 70, slippageBps: 50,  minProfitUsd: 0.20, tier: 'stable'     },
  // Volatile / low-liquidity — small size, wider slippage, frequent opportunities
  { name: 'SOL→BONK→SOL',       hops: [T.SOL, T.BONK, T.SOL],              baseTradePct: 15, slippageBps: 150, minProfitUsd: 0.10, tier: 'volatile'   },
  { name: 'SOL→WIF→SOL',        hops: [T.SOL, T.WIF,  T.SOL],              baseTradePct: 15, slippageBps: 150, minProfitUsd: 0.10, tier: 'volatile'   },
  { name: 'SOL→JUP→SOL',        hops: [T.SOL, T.JUP,  T.SOL],              baseTradePct: 20, slippageBps: 100, minProfitUsd: 0.12, tier: 'volatile'   },
  { name: 'SOL→RAY→SOL',        hops: [T.SOL, T.RAY,  T.SOL],              baseTradePct: 20, slippageBps: 100, minProfitUsd: 0.12, tier: 'volatile'   },
  { name: 'SOL→POPCAT→SOL',     hops: [T.SOL, T.POPCAT, T.SOL],            baseTradePct: 10, slippageBps: 200, minProfitUsd: 0.10, tier: 'volatile'   },
  { name: 'SOL→PYTH→SOL',       hops: [T.SOL, T.PYTH, T.SOL],              baseTradePct: 15, slippageBps: 150, minProfitUsd: 0.10, tier: 'volatile'   },
  // Triangular — 3-hop cross-pool spread capture
  { name: 'SOL→BONK→USDC→SOL', hops: [T.SOL, T.BONK, T.USDC, T.SOL],     baseTradePct: 10, slippageBps: 200, minProfitUsd: 0.20, tier: 'triangular' },
  { name: 'SOL→WIF→USDC→SOL',  hops: [T.SOL, T.WIF,  T.USDC, T.SOL],     baseTradePct: 10, slippageBps: 200, minProfitUsd: 0.20, tier: 'triangular' },
  { name: 'SOL→JUP→USDC→SOL',  hops: [T.SOL, T.JUP,  T.USDC, T.SOL],     baseTradePct: 12, slippageBps: 150, minProfitUsd: 0.20, tier: 'triangular' },
  { name: 'SOL→RAY→USDC→SOL',  hops: [T.SOL, T.RAY,  T.USDC, T.SOL],     baseTradePct: 12, slippageBps: 150, minProfitUsd: 0.20, tier: 'triangular' },
];

// ─── Runtime state ────────────────────────────────────────────────
let dailyTrades      = 0;
let dailyPnlSol      = 0;
let totalProfitSol   = 0;
let dayStart         = Date.now();
let solPrice         = 0;
let startingBalance  = 0;    // lamports — set once at startup
let lastTier         = '';
let milestonesHit    = new Set<number>();

const routeStats: Record<string, { trades: number; profitSol: number }> = {};
ROUTES.forEach(r => { routeStats[r.name] = { trades: 0, profitSol: 0 }; });

// ─── Jupiter helpers ─────────────────────────────────────────────
async function jupiterQuote(
  inputMint: string, outputMint: string, amount: number, slippageBps: number
): Promise<any | null> {
  try {
    const url = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}` +
      `&amount=${amount}&slippageBps=${slippageBps}&onlyDirectRoutes=false`;
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
    if (!res.ok) return null;
    const { swapTransaction } = await res.json() as { swapTransaction: string };
    const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
    tx.sign([wallet]);
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
    const bh = await connection.getLatestBlockhash();
    await connection.confirmTransaction({ signature: sig, ...bh }, 'confirmed');
    return sig;
  } catch { return null; }
}

async function fetchSolPrice(): Promise<number> {
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    const d = await r.json() as any;
    return d?.solana?.usd || solPrice;
  } catch { return solPrice; }
}

// ─── Check growth milestones ──────────────────────────────────────
function checkMilestones(currentLamports: number) {
  if (!startingBalance) return;
  const growth = (currentLamports - startingBalance) / startingBalance;
  for (const m of MILESTONES) {
    if (growth >= m && !milestonesHit.has(m)) {
      milestonesHit.add(m);
      const gain = ((growth) * 100).toFixed(1);
      console.log(`\n🏆 MILESTONE: +${gain}% portfolio growth!`);
      console.log(`   Start: ${(startingBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
      console.log(`   Now:   ${(currentLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
      console.log(`   Gain:  +${((currentLamports - startingBalance) / LAMPORTS_PER_SOL).toFixed(6)} SOL (+$${((currentLamports - startingBalance) / LAMPORTS_PER_SOL * solPrice).toFixed(2)})\n`);
    }
  }
}

// ─── Scan one route ───────────────────────────────────────────────
interface ArbOpportunity {
  route:          RouteConfig;
  inputLamports:  number;
  profitLamports: number;
  profitUsd:      number;
  quotes:         any[];
}

async function scanRoute(
  route: RouteConfig,
  balanceLamports: number,
  tier: ScalingTier
): Promise<ArbOpportunity | null> {
  // Apply tier multiplier to base trade size — scaling unlocks bigger trades
  const effectivePct  = Math.min(route.baseTradePct * tier.tradeMultiplier, 90);
  const tradeLamports = Math.max(
    Math.floor(balanceLamports * (effectivePct / 100)),
    CFG.minBalanceLamports
  );
  if (tradeLamports > balanceLamports * 0.95) return null;

  const numSwaps       = route.hops.length - 1;
  const estFeeLamports = 20_000 * numSwaps + CFG.priorityFeeLamports * numSwaps;

  const quotes: any[] = [];
  let amount = tradeLamports;
  for (let i = 0; i < route.hops.length - 1; i++) {
    const q = await jupiterQuote(route.hops[i], route.hops[i + 1], amount, route.slippageBps);
    if (!q) return null;
    quotes.push(q);
    amount = parseInt(q.outAmount);
  }

  const profitLamports = amount - tradeLamports - estFeeLamports;
  if (profitLamports <= 0) return null;

  const profitUsd = (profitLamports / LAMPORTS_PER_SOL) * solPrice;
  if (profitUsd < route.minProfitUsd) {
    console.log(`  [${route.tier}] ${route.name}: +$${profitUsd.toFixed(4)} (min $${route.minProfitUsd})`);
    return null;
  }

  return { route, inputLamports: tradeLamports, profitLamports, profitUsd, quotes };
}

async function scanAllRoutes(balanceLamports: number, tier: ScalingTier): Promise<ArbOpportunity | null> {
  let best: ArbOpportunity | null = null;
  for (const route of ROUTES) {
    const opp = await scanRoute(route, balanceLamports, tier);
    if (opp && (!best || opp.profitUsd > best.profitUsd)) best = opp;
  }
  return best;
}

// ─── Execute multi-hop trade ──────────────────────────────────────
async function executeTrade(opp: ArbOpportunity, wallet: Keypair, connection: Connection): Promise<boolean> {
  for (let i = 0; i < opp.quotes.length; i++) {
    const label = `${opp.route.hops[i].slice(0, 4)}→${opp.route.hops[i + 1].slice(0, 4)}`;
    console.log(`   🚀 Leg ${i + 1}/${opp.quotes.length}: ${label}...`);
    const sig = await jupiterSwap(opp.quotes[i], wallet, connection);
    if (!sig) {
      console.log(`   ❌ Leg ${i + 1} failed`);
      if (i > 0) console.log(`   ⚠️  Partial fill — check wallet for intermediate token`);
      return false;
    }
    console.log(`   ✅ Leg ${i + 1}: https://solscan.io/tx/${sig}`);
    if (i < opp.quotes.length - 1) await sleep(1500);
  }
  return true;
}

function resetDailyIfNeeded() {
  if (Date.now() - dayStart >= 24 * 60 * 60 * 1000) {
    dailyTrades = 0; dailyPnlSol = 0; dayStart = Date.now();
    console.log('\n🔄 Daily counters reset\n');
  }
}

// ─── Main ─────────────────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  AI Arbitrage Bot v3.1 — Capital Scaling Priority #1    ║');
  console.log('║  Strategy: Compound Circular Arb + Auto-Tier Unlock     ║');
  console.log(`║  Mode: ${CFG.dryRun ? 'DRY RUN 🧪                                   ' : 'LIVE 🔴                                      '}║`);
  console.log('╚══════════════════════════════════════════════════════════╝');

  if (!CFG.privateKey) { console.error('\n❌ Set PRIVATE_KEY in .env\n'); process.exit(1); }

  const wallet     = Keypair.fromSecretKey(bs58.decode(CFG.privateKey));
  const connection = new Connection(CFG.rpcUrl, 'confirmed');
  solPrice         = await fetchSolPrice();

  const initBalance  = await connection.getBalance(wallet.publicKey);
  startingBalance    = initBalance;
  const balanceSol   = initBalance / LAMPORTS_PER_SOL;
  const initTier     = getTier(balanceSol);
  lastTier           = initTier.name;

  console.log(`\n🔑 Wallet: ${wallet.publicKey.toBase58()}`);
  console.log(`💰 Balance: ${balanceSol.toFixed(4)} SOL (~$${(balanceSol * solPrice).toFixed(2)} USD)`);
  console.log(`💵 SOL: $${solPrice.toFixed(2)}`);
  console.log(`\n📈 Scaling Tier: [${initTier.name.toUpperCase()}]`);
  console.log(`   Daily cap: ${initTier.maxDailyTrades} trades`);
  console.log(`   Scan speed: ${initTier.scanIntervalMs / 1000}s`);
  console.log(`   Size boost: ${initTier.tradeMultiplier}×`);
  console.log('\n   Tier unlock thresholds:');
  TIERS.forEach(t => {
    const mark = balanceSol >= t.minSol ? '✅' : '⬜';
    const next = TIERS[TIERS.indexOf(t) + 1];
    const needed = next ? ` (next unlock: ${next.minSol} SOL)` : ' (MAX)';
    console.log(`   ${mark} ${t.name.padEnd(8)} ≥${t.minSol} SOL → ${t.maxDailyTrades} trades/day @ ${t.scanIntervalMs/1000}s${needed}`);
  });
  console.log(`\n🔍 Scanning ${ROUTES.length} routes...\n`);

  let scanCount        = 0;
  let lastPriceRefresh = 0;

  while (true) {
    resetDailyIfNeeded();

    const currentBalance = await connection.getBalance(wallet.publicKey);
    const currentSol     = currentBalance / LAMPORTS_PER_SOL;
    const tier           = getTier(currentSol);

    // Announce tier upgrade
    if (tier.name !== lastTier) {
      console.log(`\n🔓 TIER UNLOCKED: ${lastTier} → ${tier.name.toUpperCase()}`);
      console.log(`   Daily cap: ${tier.maxDailyTrades} | Scan: ${tier.scanIntervalMs/1000}s | Boost: ${tier.tradeMultiplier}×\n`);
      lastTier = tier.name;
    }

    // Check growth milestones
    checkMilestones(currentBalance);

    if (dailyTrades >= tier.maxDailyTrades) {
      const hoursLeft = Math.ceil((dayStart + 86_400_000 - Date.now()) / 3_600_000);
      if (scanCount % Math.ceil(60_000 / tier.scanIntervalMs) === 0)
        console.log(`⏸️  Daily cap hit (${dailyTrades}/${tier.maxDailyTrades}). Resets in ~${hoursLeft}h`);
      await sleep(tier.scanIntervalMs);
      scanCount++;
      continue;
    }

    if (Date.now() - lastPriceRefresh > 60_000) {
      solPrice = await fetchSolPrice();
      lastPriceRefresh = Date.now();
    }

    // Daily loss circuit-breaker
    const maxLossSol = currentSol * (CFG.maxDailyLossPct / 100);
    if (dailyPnlSol < -maxLossSol) {
      if (scanCount % 60 === 0)
        console.log(`🛑 Daily loss limit (${dailyPnlSol.toFixed(4)} SOL). Pausing until reset.`);
      await sleep(tier.scanIntervalMs);
      scanCount++;
      continue;
    }

    const opp = await scanAllRoutes(currentBalance, tier);

    if (opp) {
      const profitSol = opp.profitLamports / LAMPORTS_PER_SOL;

      console.log(`\n💡 ARB FOUND [${opp.route.tier.toUpperCase()}] ${opp.route.name}  [Tier: ${tier.name}]`);
      console.log(`   Size:    ${(opp.inputLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL  (${(opp.inputLamports / currentBalance * 100).toFixed(1)}% of balance)`);
      console.log(`   Profit:  +${profitSol.toFixed(6)} SOL  (~+$${opp.profitUsd.toFixed(4)} USD)`);
      console.log(`   Trades:  ${dailyTrades + 1}/${tier.maxDailyTrades}`);
      // Show compounding growth
      const growthPct = ((currentBalance - startingBalance) / startingBalance * 100);
      console.log(`   Growth:  ${growthPct >= 0 ? '+' : ''}${growthPct.toFixed(2)}% since start`);

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
      await sleep(8_000);
    }

    // Status report every 5 min
    const statusEvery = Math.ceil(300_000 / tier.scanIntervalMs);
    if (scanCount > 0 && scanCount % statusEvery === 0) {
      const growthPct   = ((currentBalance - startingBalance) / startingBalance * 100);
      const growthStr   = `${growthPct >= 0 ? '+' : ''}${growthPct.toFixed(2)}%`;
      console.log(`\n📊 [${tier.name}] Trades: ${dailyTrades}/${tier.maxDailyTrades} | Day: $${(dailyPnlSol * solPrice).toFixed(4)} | Total: $${(totalProfitSol * solPrice).toFixed(4)} | Bal: ${currentSol.toFixed(4)} SOL | Growth: ${growthStr}`);
      const active = Object.entries(routeStats).filter(([,v]) => v.trades > 0);
      if (active.length > 0) {
        console.log('   Best routes:');
        active.sort((a, b) => b[1].profitSol - a[1].profitSol).slice(0, 3).forEach(([n, s]) => {
          console.log(`   ${n}: ${s.trades} trades, +$${(s.profitSol * solPrice).toFixed(4)}`);
        });
      }
    }

    scanCount++;
    await sleep(tier.scanIntervalMs);  // scan speed adjusts with tier
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

main().catch(console.error);
