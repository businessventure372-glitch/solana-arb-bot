import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import { CONFIG } from './config.js';

const JUPITER_QUOTE_API = 'https://quote-api.jup.ag/v6/quote';
const JUPITER_SWAP_API = 'https://quote-api.jup.ag/v6/swap';

export interface QuoteResult {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  routePlan: any[];
}

/**
 * Get a swap quote from Jupiter aggregator
 */
export async function getQuote(
  inputMint: string,
  outputMint: string,
  amountLamports: number
): Promise<QuoteResult | null> {
  try {
    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount: amountLamports.toString(),
      slippageBps: CONFIG.slippageBps.toString(),
      onlyDirectRoutes: 'false',
      asLegacyTransaction: 'false',
    });

    const res = await fetch(`${JUPITER_QUOTE_API}?${params}`);
    if (!res.ok) return null;
    return await res.json() as QuoteResult;
  } catch (e) {
    console.error('[Jupiter] Quote error:', e);
    return null;
  }
}

/**
 * Execute a swap via Jupiter
 */
export async function executeSwap(
  quote: QuoteResult,
  wallet: Keypair,
  connection: Connection
): Promise<string | null> {
  try {
    // Get serialized transaction from Jupiter
    const swapRes = await fetch(JUPITER_SWAP_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: CONFIG.priorityFeeLamports,
      }),
    });

    if (!swapRes.ok) {
      console.error('[Jupiter] Swap API error:', await swapRes.text());
      return null;
    }

    const { swapTransaction } = await swapRes.json() as { swapTransaction: string };

    // Deserialize, sign, and send
    const txBuf = Buffer.from(swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([wallet]);

    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      maxRetries: 3,
    });

    // Confirm with timeout
    const latestBlockhash = await connection.getLatestBlockhash();
    await connection.confirmTransaction({
      signature: sig,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    }, 'confirmed');

    return sig;
  } catch (e) {
    console.error('[Jupiter] Swap execution error:', e);
    return null;
  }
}

/**
 * Get current SOL/USDC price from Jupiter quote
 */
export async function getSOLPrice(): Promise<number | null> {
  // Quote 1 SOL -> USDC to get price
  const quote = await getQuote(
    CONFIG.tokens.SOL,
    CONFIG.tokens.USDC,
    1_000_000_000 // 1 SOL in lamports
  );
  if (!quote) return null;
  // USDC has 6 decimals
  return parseInt(quote.outAmount) / 1_000_000;
}
