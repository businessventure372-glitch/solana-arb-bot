/**
 * Hybrid Capital Scaling Bot v4.0
 * Two strategies, one capital pool:
 *   Strategy 1: Circular DEX Arbitrage (12 routes, tier scaling)
 *   Strategy 2: KOL Copy Trading (from Sol-trade-bit v5.3)
 * Shared: Safety Capital Engine, Trade Memory, KOL self-learning
 */
import 'dotenv/config';
import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';

// ─── Config ──────────────────────────────────────────────────────
const CFG = {
  privateKey:          process.env.PRIVATE_KEY || '',
  rpcUrl:              process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
  dryRun:              process.env.DRY_RUN !== 'false',
  strategy:            (process.env.STRATEGY || 'both') as 'both' | 'arb' | 'copy',
  heliusKey:           process.env.HELIUS_API_KEY || '',
  githubToken:         process.env.GITHUB_TOKEN || '',
  githubRepo:          process.env.GITHUB_REPO || '',
  priorityFeeLamports: parseInt(process.env.PRIORITY_FEE_LAMPORTS || '25000'),
  arbPoolPct:          60,   // % of balance reserved for arb
  copyPoolPct:         40,   // % of balance reserved for copy trading
};

// ─── Scaling tiers ────────────────────────────────────────────────
interface Tier { name: string; minSol: number; maxDailyTrades: number; scanMs: number; mult: number; }
const TIERS: Tier[] = [
  { name: 'Seed',   minSol: 0.00, maxDailyTrades: 10, scanMs: 4000, mult: 1.0 },
  { name: 'Growth', minSol: 0.15, maxDailyTrades: 15, scanMs: 3000, mult: 1.1 },
  { name: 'Scale',  minSol: 0.30, maxDailyTrades: 20, scanMs: 2500, mult: 1.2 },
  { name: 'Turbo',  minSol: 0.50, maxDailyTrades: 25, scanMs: 2000, mult: 1.3 },
  { name: 'Hyper',  minSol: 1.00, maxDailyTrades: 35, scanMs: 1500, mult: 1.5 },
];
function getTier(sol: number): Tier {
  for (let i = TIERS.length - 1; i >= 0; i--) if (sol >= TIERS[i].minSol) return TIERS[i];
  return TIERS[0];
}

// ─── Safety Capital Scale Engine (from Sol-trade-bit v5.3) ───────
const SAFETY = {
  baseRiskPct:    0.08,   // 8% of pool per trade
  minPosSol:      0.005,
  maxPosSol:      0.12,
  dailyLossLimit: 0.35,   // halt if day loss > 35% of start
  drawdownLimit:  0.50,   // halt if balance < start * 50%
  haltMs:         3 * 60 * 60 * 1000,
};

// ─── Tokens ──────────────────────────────────────────────────────
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

// ─── Arb routes ───────────────────────────────────────────────────
interface Route { name: string; hops: string[]; basePct: number; slipBps: number; minProfitUsd: number; tier: string; }
const ROUTES: Route[] = [
  { name: 'SOL->USDC->SOL',       hops: [T.SOL,T.USDC,T.SOL],          basePct:70, slipBps:50,  minProfitUsd:0.20, tier:'stable'     },
  { name: 'SOL->USDT->SOL',       hops: [T.SOL,T.USDT,T.SOL],          basePct:70, slipBps:50,  minProfitUsd:0.20, tier:'stable'     },
  { name: 'SOL->BONK->SOL',       hops: [T.SOL,T.BONK,T.SOL],          basePct:15, slipBps:150, minProfitUsd:0.10, tier:'volatile'   },
  { name: 'SOL->WIF->SOL',        hops: [T.SOL,T.WIF, T.SOL],          basePct:15, slipBps:150, minProfitUsd:0.10, tier:'volatile'   },
  { name: 'SOL->JUP->SOL',        hops: [T.SOL,T.JUP, T.SOL],          basePct:20, slipBps:100, minProfitUsd:0.12, tier:'volatile'   },
  { name: 'SOL->RAY->SOL',        hops: [T.SOL,T.RAY, T.SOL],          basePct:20, slipBps:100, minProfitUsd:0.12, tier:'volatile'   },
  { name: 'SOL->POPCAT->SOL',     hops: [T.SOL,T.POPCAT,T.SOL],        basePct:10, slipBps:200, minProfitUsd:0.10, tier:'volatile'   },
  { name: 'SOL->PYTH->SOL',       hops: [T.SOL,T.PYTH,T.SOL],          basePct:15, slipBps:150, minProfitUsd:0.10, tier:'volatile'   },
  { name: 'SOL->BONK->USDC->SOL', hops: [T.SOL,T.BONK,T.USDC,T.SOL],  basePct:10, slipBps:200, minProfitUsd:0.20, tier:'triangular' },
  { name: 'SOL->WIF->USDC->SOL',  hops: [T.SOL,T.WIF, T.USDC,T.SOL],  basePct:10, slipBps:200, minProfitUsd:0.20, tier:'triangular' },
  { name: 'SOL->JUP->USDC->SOL',  hops: [T.SOL,T.JUP, T.USDC,T.SOL],  basePct:12, slipBps:150, minProfitUsd:0.20, tier:'triangular' },
  { name: 'SOL->RAY->USDC->SOL',  hops: [T.SOL,T.RAY, T.USDC,T.SOL],  basePct:12, slipBps:150, minProfitUsd:0.20, tier:'triangular' },
];

// ─── KOL wallets (from Sol-trade-bit v5.3, verified Apr 2026) ─────
const KOL_WALLETS = [
  'CyaE1VxvBrahnPWkqm5VsdCvyS2QmNht2UFrKJHga54o',  // Cented  +2560 SOL/30d
  'FixmSpsBa7ew26gWdiqpoMAgKRFgbSXFbGAgfMZw67X',   // Marcell +573 SOL/30d
  '4BdKaxN8G6ka4GYtQQWk4G4dZRUTX2vQH9GcXdBREFUk', // Jijo    +561 SOL/30d 71%win
  'G3gZWqrYkNmYFKYCyfRCNtGuxdyuE2wiYKkZpiZn4WSS', // Goyim   +456 SOL/30d
];

// ─── Runtime state ────────────────────────────────────────────────
let solPrice       = 0;
let startBalance   = 0;
let dayStart       = Date.now();
let dailyTrades    = 0;
let dailyPnlSol    = 0;
let totalProfitSol = 0;
let haltUntil      = 0;
let lastTierName   = '';
const milestonesHit = new Set<number>();
const MILESTONES = [0.10, 0.25, 0.50, 1.00, 2.00, 5.00];

// Positions: tokenMint -> {entryPrice, highestPrice, amountLamports, symbol, kolWallet}
const positions = new Map<string, any>();

// KOL self-learning: wallet -> {trades, wins, totalPnl}
const kolScores = new Map<string, { trades: number; wins: number; totalPnl: number }>();
KOL_WALLETS.forEach(w => kolScores.set(w, { trades: 0, wins: 0, totalPnl: 0 }));

const routeStats: Record<string, { trades: number; profitSol: number }> = {};
ROUTES.forEach(r => { routeStats[r.name] = { trades: 0, profitSol: 0 }; });

let memFileSha = '';
const tradeHistory: any[] = [];

// ─── GitHub Trade Memory ──────────────────────────────────────────
async function loadMemory() {
  if (!CFG.githubToken || !CFG.githubRepo) {
    console.log('  Memory: session-only (set GITHUB_TOKEN + GITHUB_REPO to persist)');
    return;
  }
  try {
    const r = await safeFetch(
      `https://api.github.com/repos/${CFG.githubRepo}/contents/memory.json`,
      { headers: { Authorization: `token ${CFG.githubToken}`, Accept: 'application/vnd.github.v3+json' } }
    );
    if (!r?.content) return;
    const raw = JSON.parse(Buffer.from(r.content.replace(/\n/g,''), 'base64').toString('utf8'));
    if (raw.kolScores) for (const [w, s] of Object.entries<any>(raw.kolScores)) kolScores.set(w, s);
    if (raw.tradeHistory) tradeHistory.push(...raw.tradeHistory.slice(-500));
    if (r.sha) memFileSha = r.sha;
    const wins = tradeHistory.filter((t: any) => t.pnl > 0).length;
    console.log(`  Memory: ${tradeHistory.length} trades (${wins} wins) loaded from GitHub`);
  } catch (e: any) { console.log('  Memory load failed:', e.message); }
}

async function saveMemory(trade?: any) {
  if (trade) {
    tradeHistory.push(trade);
    if (tradeHistory.length > 500) tradeHistory.splice(0, tradeHistory.length - 500);
  }
  if (!CFG.githubToken || !CFG.githubRepo) return;
  try {
    const payload = { kolScores: Object.fromEntries(kolScores), tradeHistory: tradeHistory.slice(-200), updatedAt: new Date().toISOString() };
    const body: any = { message: `memory: ${tradeHistory.length} trades`, content: Buffer.from(JSON.stringify(payload, null, 2)).toString('base64') };
    if (memFileSha) body.sha = memFileSha;
    const r = await safeFetch(
      `https://api.github.com/repos/${CFG.githubRepo}/contents/memory.json`,
      { method: 'PUT', headers: { Authorization: `token ${CFG.githubToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    );
    if (r?.content?.sha) memFileSha = r.content.sha;
  } catch { /* silent */ }
}

// ─── Quantification Engine (from Sol-trade-bit v5.3) ─────────────
function quantifySignal(kolWallet: string, info: any): { score: number; action: string; multiplier: number } {
  let score = 0;
  const kol = kolScores.get(kolWallet);
  const kolWr = kol && kol.trades >= 2 ? kol.wins / kol.trades : 0.5;
  score += Math.round(kolWr * 40);
  if (info?.createdAt) {
    const ageH = (Date.now() / 1000 - info.createdAt) / 3600;
    score += ageH < 1 ? 20 : ageH < 2 ? 17 : ageH < 4 ? 13 : ageH < 8 ? 8 : 3;
  }
  if (info?.volume24h && info?.liquidity) {
    const ratio = info.volume24h / info.liquidity;
    score += ratio >= 5 ? 15 : ratio >= 3 ? 12 : ratio >= 1.5 ? 8 : ratio >= 1 ? 5 : 2;
  }
  if (info) {
    const ch5m = info.priceChange5m || 0, ch1h = info.priceChange1h || 0;
    const buys = info.buys1h || 0, sells = info.sells1h || 0;
    if (ch1h < -5 && ch5m < 0) { score = 0; }
    else {
      let m = ch5m > 20 ? 10 : ch5m > 10 ? 7 : ch5m > 5 ? 5 : ch5m > 0 ? 2 : -3;
      m += ch1h > 30 ? 8 : ch1h > 15 ? 5 : ch1h > 5 ? 3 : ch1h < 0 ? -4 : 0;
      if (buys + sells > 0) { const bsr = buys / (buys + sells); m += bsr > 0.75 ? 7 : bsr > 0.60 ? 4 : bsr < 0.35 ? -5 : 0; }
      score += m;
    }
  }
  score = Math.max(0, Math.min(100, score));
  const action = score >= 75 ? 'FULL+' : score >= 55 ? 'FULL' : score >= 35 ? 'HALF' : 'SKIP';
  const multiplier = score >= 75 ? 1.3 : score >= 55 ? 1.0 : score >= 35 ? 0.7 : 0;
  return { score, action, multiplier };
}

// ─── Safety gates ─────────────────────────────────────────────────
function getScaledPos(poolSol: number, mult = 1.0): number {
  return Math.max(SAFETY.minPosSol, Math.min(poolSol * SAFETY.baseRiskPct * mult, SAFETY.maxPosSol));
}

function checkSafetyGates(lamports: number): boolean {
  if (Date.now() < haltUntil) { console.log(`  Safety halt: ${Math.ceil((haltUntil - Date.now())/60000)} min left`); return false; }
  const sol = lamports / LAMPORTS_PER_SOL, start = startBalance / LAMPORTS_PER_SOL;
  if (start > 0 && sol < start * (1 - SAFETY.drawdownLimit)) { haltUntil = Date.now() + SAFETY.haltMs; console.log(`  DRAWDOWN HALT (${((1-sol/start)*100).toFixed(1)}%)`); return false; }
  if (dailyPnlSol < -(start * SAFETY.dailyLossLimit)) { haltUntil = Date.now() + SAFETY.haltMs; console.log(`  DAILY LOSS HALT`); return false; }
  return true;
}

function resetDaily() {
  if (Date.now() - dayStart >= 86_400_000) { dailyTrades = 0; dailyPnlSol = 0; dayStart = Date.now(); console.log('\n  Daily counters reset\n'); }
}

function checkMilestones(lamports: number) {
  if (!startBalance) return;
  const g = (lamports - startBalance) / startBalance;
  for (const m of MILESTONES) {
    if (g >= m && !milestonesHit.has(m)) {
      milestonesHit.add(m);
      console.log(`\n  MILESTONE +${(m*100).toFixed(0)}%! Bal: ${(lamports/LAMPORTS_PER_SOL).toFixed(4)} SOL\n`);
    }
  }
}

// ─── Jupiter ──────────────────────────────────────────────────────
async function jupiterQuote(inp: string, out: string, amount: number, slipBps: number): Promise<any|null> {
  try {
    const r = await fetch(`https://quote-api.jup.ag/v6/quote?inputMint=${inp}&outputMint=${out}&amount=${amount}&slippageBps=${slipBps}&onlyDirectRoutes=false`);
    return r.ok ? r.json() : null;
  } catch { return null; }
}

async function jupiterSwap(quote: any, wallet: Keypair, conn: Connection): Promise<string|null> {
  try {
    const r = await fetch('https://quote-api.jup.ag/v6/swap', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quoteResponse: quote, userPublicKey: wallet.publicKey.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: CFG.priorityFeeLamports }),
    });
    if (!r.ok) return null;
    const { swapTransaction } = await r.json() as any;
    const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
    tx.sign([wallet]);
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
    const bh = await conn.getLatestBlockhash();
    await conn.confirmTransaction({ signature: sig, ...bh }, 'confirmed');
    return sig;
  } catch { return null; }
}

// ─── DexScreener token info (no API key) ─────────────────────────
async function getTokenInfo(mint: string): Promise<any|null> {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    if (!r.ok) return null;
    const d = await r.json() as any;
    const p = d?.pairs?.[0];
    if (!p) return null;
    return {
      price: parseFloat(p.priceUsd || '0'),
      priceChange5m: p.priceChange?.m5 || 0, priceChange1h: p.priceChange?.h1 || 0,
      volume24h: p.volume?.h24 || 0, liquidity: p.liquidity?.usd || 0,
      buys1h: p.txns?.h1?.buys || 0, sells1h: p.txns?.h1?.sells || 0,
      symbol: p.baseToken?.symbol || mint.slice(0,6),
      createdAt: p.pairCreatedAt ? p.pairCreatedAt / 1000 : null,
    };
  } catch { return null; }
}

async function safeFetch(url: string, opts: any = {}): Promise<any|null> {
  try { const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(10_000) }); return r.ok ? r.json() : null; }
  catch { return null; }
}

async function fetchSolPrice(): Promise<number> {
  try { const d = await safeFetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd') as any; return d?.solana?.usd || solPrice; }
  catch { return solPrice; }
}

// ─── ARB STRATEGY ─────────────────────────────────────────────────
interface ArbOpp { route: Route; inputL: number; profitL: number; profitUsd: number; quotes: any[]; }

async function scanArb(balanceL: number, tier: Tier): Promise<ArbOpp|null> {
  const poolL = CFG.strategy === 'both' ? Math.floor(balanceL * CFG.arbPoolPct / 100) : balanceL;
  let best: ArbOpp|null = null;
  for (const route of ROUTES) {
    const pct = Math.min(route.basePct * tier.mult, 90);
    const trade = Math.max(Math.floor(poolL * pct / 100), 10_000_000);
    if (trade > poolL * 0.95) continue;
    const nSwaps = route.hops.length - 1;
    const fee = 20_000 * nSwaps + CFG.priorityFeeLamports * nSwaps;
    const quotes: any[] = [];
    let amount = trade;
    for (let i = 0; i < nSwaps; i++) {
      const q = await jupiterQuote(route.hops[i], route.hops[i+1], amount, route.slipBps);
      if (!q) { quotes.length = 0; break; }
      quotes.push(q); amount = parseInt(q.outAmount);
    }
    if (quotes.length < nSwaps) continue;
    const profit = amount - trade - fee;
    if (profit <= 0) continue;
    const profitUsd = (profit / LAMPORTS_PER_SOL) * solPrice;
    if (profitUsd < route.minProfitUsd) { console.log(`  [arb] ${route.name}: +$${profitUsd.toFixed(4)} sub-threshold`); continue; }
    if (!best || profitUsd > best.profitUsd) best = { route, inputL: trade, profitL: profit, profitUsd, quotes };
  }
  return best;
}

async function execArb(opp: ArbOpp, wallet: Keypair, conn: Connection): Promise<boolean> {
  for (let i = 0; i < opp.quotes.length; i++) {
    const sig = await jupiterSwap(opp.quotes[i], wallet, conn);
    if (!sig) { console.log(`  Leg ${i+1} failed`); return false; }
    console.log(`  Leg ${i+1}: https://solscan.io/tx/${sig}`);
    if (i < opp.quotes.length - 1) await sleep(1500);
  }
  return true;
}

// ─── COPY TRADING STRATEGY ────────────────────────────────────────
async function getKolBuys(kolWallet: string): Promise<{mint:string;symbol:string}[]> {
  if (!CFG.heliusKey) return [];
  try {
    const txs: any[] = await safeFetch(`https://api.helius.xyz/v0/addresses/${kolWallet}/transactions?api-key=${CFG.heliusKey}&limit=10&type=SWAP`) || [];
    const now = Date.now() / 1000;
    const res: {mint:string;symbol:string}[] = [];
    for (const tx of txs) {
      if (!tx.timestamp || now - tx.timestamp > 300) continue;
      for (const t of tx.tokenTransfers || []) {
        if (t.toUserAccount === kolWallet && t.mint !== T.SOL) res.push({ mint: t.mint, symbol: t.tokenSymbol || '?' });
      }
    }
    return res;
  } catch { return []; }
}

async function runCopyTrade(wallet: Keypair, conn: Connection, balanceL: number) {
  if (positions.size >= 7) return;
  const poolL = CFG.strategy === 'both' ? Math.floor(balanceL * CFG.copyPoolPct / 100) : balanceL;
  const poolSol = poolL / LAMPORTS_PER_SOL;
  for (const kolWallet of KOL_WALLETS) {
    const buys = await getKolBuys(kolWallet);
    for (const { mint, symbol } of buys) {
      if (positions.has(mint)) continue;
      const info = await getTokenInfo(mint);
      if (!info) continue;
      const { score, action, multiplier } = quantifySignal(kolWallet, info);
      if (action === 'SKIP') continue;
      const posSol = getScaledPos(poolSol, multiplier);
      const posL = Math.floor(posSol * LAMPORTS_PER_SOL);
      if (posL > poolL * 0.95) continue;
      console.log(`\n  COPY [${symbol}] KOL:${kolWallet.slice(0,8)} Score:${score} ${action} Size:${posSol.toFixed(4)}SOL 5m:${info.priceChange5m?.toFixed(1)}%`);
      if (CFG.dryRun) {
        positions.set(mint, { entryPrice: info.price, highestPrice: info.price, amountL: posL, symbol, kolWallet });
        console.log('  [DRY RUN] Position opened');
      } else {
        const q = await jupiterQuote(T.SOL, mint, posL, 300);
        if (!q) continue;
        const sig = await jupiterSwap(q, wallet, conn);
        if (sig) { console.log(`  Bought: https://solscan.io/tx/${sig}`); positions.set(mint, { entryPrice: info.price, highestPrice: info.price, amountL: posL, symbol, kolWallet }); dailyTrades++; }
      }
    }
  }
}

async function monitorPositions(wallet: Keypair, conn: Connection) {
  for (const [mint, pos] of positions.entries()) {
    const info = await getTokenInfo(mint);
    if (!info?.price || !pos.entryPrice) continue;
    const pct = ((info.price - pos.entryPrice) / pos.entryPrice) * 100;
    pos.highestPrice = Math.max(pos.highestPrice, info.price);
    const trail = ((info.price - pos.highestPrice) / pos.highestPrice) * 100;
    let reason = '';
    if (pct <= -15)   reason = `STOP_LOSS (${pct.toFixed(1)}%)`;
    else if (pct >= 175) reason = `TAKE_PROFIT (+${pct.toFixed(1)}%)`;
    else if (trail <= -8) reason = `TRAILING_STOP (${trail.toFixed(1)}%)`;
    if (!reason) continue;
    console.log(`\n  SELL [${pos.symbol}] ${reason}`);
    const pnlSol = (pos.amountL / LAMPORTS_PER_SOL) * (pct / 100);
    if (!CFG.dryRun) {
      const accounts = await conn.getTokenAccountsByOwner(wallet.publicKey, { mint: new PublicKey(mint) });
      if (accounts.value.length) {
        const bal = await conn.getTokenAccountBalance(accounts.value[0].pubkey);
        const tokenBal = parseInt(bal.value.amount);
        if (tokenBal > 0) {
          const q = await jupiterQuote(mint, T.SOL, tokenBal, 300);
          if (q) { const sig = await jupiterSwap(q, wallet, conn); if (sig) console.log(`  Sold: https://solscan.io/tx/${sig}`); }
        }
      }
    } else { console.log(`  [DRY RUN] Closed ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`); }
    dailyPnlSol += pnlSol; totalProfitSol += pnlSol;
    const kol = kolScores.get(pos.kolWallet) || { trades: 0, wins: 0, totalPnl: 0 };
    kol.trades++; if (pct > 0) kol.wins++; kol.totalPnl += pnlSol; kolScores.set(pos.kolWallet, kol);
    positions.delete(mint);
    await saveMemory({ strategy: 'copy', symbol: pos.symbol, pnl: pnlSol, pct, kolWallet: pos.kolWallet, reason, closedAt: new Date().toISOString() });
  }
}

// ─── Main ─────────────────────────────────────────────────────────
async function main() {
  console.log('============================================================');
  console.log('  Hybrid Capital Scaling Bot v4.0');
  console.log('  Strategy 1: DEX Arbitrage  (12 routes, 5-tier scaling)');
  console.log('  Strategy 2: KOL Copy Trade (momentum scoring, stop-loss)');
  console.log(`  Mode: ${CFG.dryRun ? 'DRY RUN' : 'LIVE'} | Active: ${CFG.strategy.toUpperCase()}`);
  console.log('============================================================');

  if (!CFG.privateKey) { console.error('Set PRIVATE_KEY in .env'); process.exit(1); }
  const wallet = Keypair.fromSecretKey(bs58.decode(CFG.privateKey));
  const conn   = new Connection(CFG.rpcUrl, 'confirmed');
  solPrice     = await fetchSolPrice();

  const initBal = await conn.getBalance(wallet.publicKey);
  startBalance  = initBal;
  const initTier = getTier(initBal / LAMPORTS_PER_SOL);
  lastTierName   = initTier.name;

  await loadMemory();

  console.log(`\n  Wallet:  ${wallet.publicKey.toBase58()}`);
  console.log(`  Balance: ${(initBal / LAMPORTS_PER_SOL).toFixed(4)} SOL (~$${(initBal / LAMPORTS_PER_SOL * solPrice).toFixed(2)})`);
  console.log(`  SOL:     $${solPrice.toFixed(2)}`);
  console.log(`  Tier:    [${initTier.name}] ${initTier.maxDailyTrades} trades/day | ${initTier.scanMs/1000}s | ${initTier.mult}x boost`);
  if (CFG.strategy !== 'arb') {
    console.log(`  KOL wallets: ${KOL_WALLETS.length} | Max positions: 7`);
    if (!CFG.heliusKey) console.log('  HELIUS_API_KEY not set — copy trading disabled (arb only)');
  }
  console.log('\n  Scanning...\n');

  let scanN = 0, lastPrice = 0, lastCopy = 0, lastPos = 0;

  while (true) {
    resetDaily();
    const bal  = await conn.getBalance(wallet.publicKey);
    const sol  = bal / LAMPORTS_PER_SOL;
    const tier = getTier(sol);

    if (tier.name !== lastTierName) {
      console.log(`\n  TIER UNLOCKED: ${lastTierName} -> ${tier.name} | ${tier.maxDailyTrades} trades | ${tier.scanMs/1000}s | ${tier.mult}x\n`);
      lastTierName = tier.name;
    }

    checkMilestones(bal);

    if (!checkSafetyGates(bal)) { await sleep(tier.scanMs); scanN++; continue; }
    if (Date.now() - lastPrice > 60_000) { solPrice = await fetchSolPrice(); lastPrice = Date.now(); }

    // Strategy 1: Arb
    if (CFG.strategy !== 'copy' && dailyTrades < tier.maxDailyTrades) {
      const opp = await scanArb(bal, tier);
      if (opp) {
        const pSol = opp.profitL / LAMPORTS_PER_SOL;
        const growth = ((bal - startBalance) / startBalance * 100).toFixed(2);
        console.log(`\n  ARB [${opp.route.tier}] ${opp.route.name} | +$${opp.profitUsd.toFixed(4)} | Growth: ${growth}%`);
        if (CFG.dryRun) {
          dailyTrades++; dailyPnlSol += pSol; totalProfitSol += pSol;
          routeStats[opp.route.name].trades++; routeStats[opp.route.name].profitSol += pSol;
          console.log(`  [DRY RUN] +$${opp.profitUsd.toFixed(4)}`);
        } else {
          if (await execArb(opp, wallet, conn)) {
            dailyTrades++; dailyPnlSol += pSol; totalProfitSol += pSol;
            routeStats[opp.route.name].trades++; routeStats[opp.route.name].profitSol += pSol;
            await saveMemory({ strategy: 'arb', route: opp.route.name, pnl: pSol, closedAt: new Date().toISOString() });
          }
        }
        await sleep(8_000);
      }
    }

    // Strategy 2: Copy
    if (CFG.strategy !== 'arb' && CFG.heliusKey) {
      if (Date.now() - lastCopy > 15_000) { await runCopyTrade(wallet, conn, bal); lastCopy = Date.now(); }
      if (Date.now() - lastPos  > 5_000 && positions.size > 0) { await monitorPositions(wallet, conn); lastPos = Date.now(); }
    }

    // Status every 5 min
    const evN = Math.ceil(300_000 / tier.scanMs);
    if (scanN > 0 && scanN % evN === 0) {
      const g = ((bal - startBalance) / startBalance * 100);
      console.log(`\n  [${tier.name}] Trades:${dailyTrades}/${tier.maxDailyTrades} | Day:$${(dailyPnlSol*solPrice).toFixed(4)} | Total:$${(totalProfitSol*solPrice).toFixed(4)} | Bal:${sol.toFixed(4)} SOL | Growth:${g >= 0 ? '+' : ''}${g.toFixed(2)}%`);
      const top = Object.entries(routeStats).filter(([,v]) => v.trades > 0).sort((a,b) => b[1].profitSol - a[1].profitSol).slice(0,3);
      if (top.length) { console.log('  Top routes: ' + top.map(([n,s]) => `${n.split('->').slice(-1)[0].replace('SOL','')} +$${(s.profitSol*solPrice).toFixed(4)}`).join(' | ')); }
      if (positions.size > 0) {
        const pos = [...positions.values()].map((p: any) => p.symbol).join(', ');
        console.log(`  Copy positions: ${positions.size} | ${pos}`);
      }
      const topKol = [...kolScores.entries()].filter(([,s]) => s.trades > 0).sort((a,b) => b[1].totalPnl - a[1].totalPnl);
      if (topKol.length) { console.log('  KOL scores: ' + topKol.map(([w,s]) => `${w.slice(0,6)} ${s.wins}/${s.trades}`).join(' | ')); }
    }

    scanN++;
    await sleep(tier.scanMs);
  }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
main().catch(console.error);
