#!/data/data/com.termux/files/usr/bin/bash
# AI Arbitrage Bot — Termux Setup (pre-bundled, no npm install needed)
set -e
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║   AI Arbitrage Bot — Auto Setup              ║"
echo "║   Strategy: Cross-DEX Circular Arbitrage     ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# ── 1. Deps (nodejs + curl only) ──────────────────────────────────
echo -e "${YELLOW}[1/3] Installing dependencies...${NC}"
pkg update -y -q
pkg install -y -q nodejs-lts curl
echo -e "${GREEN}✓ Done${NC}"

# ── 2. Download pre-bundled bot ───────────────────────────────────
echo -e "${YELLOW}[2/3] Downloading bot...${NC}"
mkdir -p ~/arb-bot
cd ~/arb-bot
curl -gL "https://surething.io/api/files/a5caad24-dcbf-4a0d-b643-27405772db87/download?t=OqlFjrFU3XLJ8n94gpqxzA.1780528683" -o bot.js
echo -e "${GREEN}✓ Bot downloaded${NC}"

# ── 3. Generate wallet + write .env ──────────────────────────────
echo -e "${YELLOW}[3/3] Generating trading wallet...${NC}"

KEYPAIR_JSON=$(node -e "
const crypto = require('crypto');
const ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(buf) {
  let d = [], s = '';
  for (let b of buf) { let c = b; for (let j = 0; j < d.length; j++) { let x = (d[j] << 8) + c; d[j] = x % 58; c = x / 58 | 0; } while (c > 0) { d.push(c % 58); c = c / 58 | 0; } }
  for (let b of buf) { if (b === 0) s += ALPHA[0]; else break; }
  return s + d.reverse().map(i => ALPHA[i]).join('');
}
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const privBytes = Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64');
const pubBytes  = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64');
const secretKey = Buffer.concat([privBytes, pubBytes]);
console.log(JSON.stringify({ pub: b58(pubBytes), priv: b58(secretKey) }));
")

PUBKEY=$(echo $KEYPAIR_JSON | node -e "process.stdin.resume();let d='';process.stdin.on('data',x=>d+=x);process.stdin.on('end',()=>console.log(JSON.parse(d).pub));")
PRIVKEY=$(echo $KEYPAIR_JSON | node -e "process.stdin.resume();let d='';process.stdin.on('data',x=>d+=x);process.stdin.on('end',()=>console.log(JSON.parse(d).priv));")

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  ✅ TRADING WALLET CREATED                       ║${NC}"
echo -e "${GREEN}╠══════════════════════════════════════════════════╣${NC}"
printf "${GREEN}║  Address: %-38s ║${NC}\n" "$PUBKEY"
echo -e "${GREEN}║  Private key saved to .env (NEVER share it)      ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════╝${NC}"
echo ""

# ── RPC (Helius free tier recommended) ───────────────────────────
echo "  Free Helius RPC → https://helius.dev (2 min signup)"
echo ""
read -p "  Paste Helius API key (or Enter to use public RPC): " HELIUS_KEY

if [ -z "$HELIUS_KEY" ]; then
  echo -e "${YELLOW}⚠  Using public RPC. Get a free Helius key later and update .env${NC}"
  RPC_URL="https://api.mainnet-beta.solana.com"
else
  RPC_URL="https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}"
fi

# ── Write .env ────────────────────────────────────────────────────
cat > .env << EOF
PRIVATE_KEY=${PRIVKEY}
RPC_URL=${RPC_URL}

# Strategy (based on AI Arbitrage Trading System Specifications)
MAX_DAILY_TRADES=3
MIN_PROFIT_USD=0.20
TRADE_SIZE_PCT=80
MAX_DAILY_LOSS_PCT=5
SLIPPAGE_BPS=50
PRIORITY_FEE_LAMPORTS=10000

# Safety: DRY_RUN=true = simulate only (no real trades)
# Change to false when ready to go live
DRY_RUN=true
EOF

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║  🎉 ALL DONE                                     ║"
echo "╠══════════════════════════════════════════════════╣"
echo "║  Next steps:                                     ║"
echo "║  1. Send \$10–15 SOL to the address above        ║"
echo "║  2. cd ~/arb-bot                                 ║"
echo "║  3. node bot.js          ← runs in DRY RUN mode  ║"
echo "║  4. Edit .env: DRY_RUN=false  ← go live          ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""
echo "  Wallet address: $PUBKEY"
echo ""
echo "  Target: \$0.20/trade × 3 trades/day = \$0.60/day"
echo ""
