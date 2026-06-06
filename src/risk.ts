import { CONFIG } from './config.js';

export interface TradeRecord {
  timestamp: number;
  type: 'buy' | 'sell';
  amountLamports: number;
  price: number;
  pnl?: number;
  txSig: string;
}

export class RiskManager {
  private trades: TradeRecord[] = [];
  private dailyPnl = 0;
  private dayStart = Date.now();
  private totalBalanceLamports: number;

  constructor(initialBalanceLamports: number) {
    this.totalBalanceLamports = initialBalanceLamports;
  }

  /**
   * Check if we can open a new position
   */
  canTrade(): { allowed: boolean; reason?: string } {
    this.resetDailyIfNeeded();

    // Check daily loss limit
    const maxDailyLoss = (this.totalBalanceLamports / 1e9) * (CONFIG.maxDailyLossPercent / 100);
    if (this.dailyPnl < -maxDailyLoss) {
      return { allowed: false, reason: `Daily loss limit hit: ${this.dailyPnl.toFixed(4)} SOL` };
    }

    return { allowed: true };
  }

  /**
   * Calculate position size in lamports
   */
  getPositionSize(): number {
    const maxSize = Math.floor(
      this.totalBalanceLamports * (CONFIG.maxPositionSizePercent / 100)
    );
    return Math.max(maxSize, CONFIG.minTradeAmountLamports);
  }

  /**
   * Record a completed trade
   */
  recordTrade(trade: TradeRecord): void {
    this.trades.push(trade);
    if (trade.pnl !== undefined) {
      this.dailyPnl += trade.pnl;
    }
  }

  /**
   * Update balance after trade
   */
  updateBalance(newBalanceLamports: number): void {
    this.totalBalanceLamports = newBalanceLamports;
  }

  /**
   * Get trading stats
   */
  getStats() {
    const wins = this.trades.filter(t => t.pnl && t.pnl > 0).length;
    const losses = this.trades.filter(t => t.pnl && t.pnl < 0).length;
    const totalPnl = this.trades.reduce((sum, t) => sum + (t.pnl || 0), 0);

    return {
      totalTrades: this.trades.length,
      wins,
      losses,
      winRate: this.trades.length > 0 ? (wins / this.trades.length * 100).toFixed(1) : '0',
      totalPnl: totalPnl.toFixed(6),
      dailyPnl: this.dailyPnl.toFixed(6),
      currentBalance: (this.totalBalanceLamports / 1e9).toFixed(4),
    };
  }

  private resetDailyIfNeeded(): void {
    const now = Date.now();
    if (now - this.dayStart > 24 * 60 * 60 * 1000) {
      this.dailyPnl = 0;
      this.dayStart = now;
    }
  }
}
