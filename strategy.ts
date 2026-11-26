// Sharpe-first paper bot for the agent-fun/replay/v2 pump.fun replay.
//
// One small momentum-filtered buy per coin, then a whole-position exit on take
// profit (+12%), stop loss (-10%) or a time limit, and never re-enter the coin.
// Quick small round trips on many coins: steady edge beats one moonshot, and
// the drawdown cap stays far below 50% because every position is tiny and
// tightly stopped.
//
// Deterministic by construction: a pure function of the batch stream, no
// clock, no environment, no Math.random, nothing but insertion-ordered maps.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS = 1_000_000_000;

/** Curve fee on a sell: protocol 95 bps + creator 30 bps fallback. */
const CURVE_FEE_BPS = 125;

export interface Params {
  /** SOL spent per entry buy. */
  buySol: number;
  /** Smallest buy worth sending (round trips must be at least 0.01 SOL). */
  minBuySol: number;
  /** Sell whole position when net proceeds reach this multiple of cost. */
  takeProfit: number;
  /** Sell whole position when net proceeds fall to this multiple of cost. */
  stopLoss: number;
  /** Latest slot a position may be held before a time-limit exit. */
  maxHoldSlots: number;
  /** A coin needs this much real SOL reserve so the 1% order cap allows our buy. */
  minRqSol: number;
  /** Tape window in slots for the momentum entry filter. */
  window: number;
  /** Minimum buy trades in the window. */
  minBuys: number;
  /** Minimum net buy SOL (buys minus sells) in the window. */
  minNetSol: number;
  /** Minimum price rise over the window. */
  minPriceUp: number;
  /** Buy slippage tolerance (bps); sells go out at market. */
  buySlipBps: number;
}

export const DEFAULT_PARAMS: Params = {
  buySol: 0.05,
  minBuySol: 0.01,
  takeProfit: 1.12,
  stopLoss: 0.90,
  maxHoldSlots: 1500,
  minRqSol: 2,
  window: 50,
  minBuys: 2,
  minNetSol: 0,
  minPriceUp: 0,
  buySlipBps: 500,
};

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;      // lamports
  price: number;    // SOL per token at that trade (virtual quote / virtual token)
}

interface Tape {
  created: number | null;
  trades: Trade[];
}

interface Held {
  opened: number;   // slot the entry buy was decided on
  exiting: boolean; // a sell order is in flight
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  const retired = new Set<Pubkey>(); // coins that already had their one position
  const keep = Math.max(p.window, p.maxHoldSlots) + 100;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, trades: [] };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Momentum entry filter on a coin's tape at slot `now`. */
  const entrySignal = (t: Tape, now: number): boolean => {
    const from = now - p.window;
    let startPrice = -1;
    let lastPrice = 0;
    let buys = 0;
    let netSol = 0;
    for (const tr of t.trades) {
      if (tr.slot < from) continue;
      if (startPrice < 0) startPrice = tr.price;
      lastPrice = tr.price;
      netSol += tr.buy ? tr.sol : -tr.sol;
      if (tr.buy) buys += 1;
    }
    if (buys < p.minBuys) return false;
    if (netSol < p.minNetSol * LAMPORTS) return false;
    if (startPrice <= 0) return false;
    return lastPrice / startPrice - 1 >= p.minPriceUp;
  };

  /** Net SOL from selling all held tokens right now, after curve and tx fees. */
  const netSellLamports = (tokens: bigint, vq: bigint, vt: bigint, txFeeLamports: bigint): number => {
    if (vt <= 0n) return -1;
    const share = Number(tokens) / (Number(vt) + Number(tokens));
    const gross = share * Number(vq); // lamports of SOL before fees
    return gross * (1 - CURVE_FEE_BPS / 10000) - Number(txFeeLamports);
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const { caps } = state.hello;
      const cap = caps.max_orders_per_batch;
      const orders: OrderInput[] = [];
      const txFee = state.txFeeLamports();

      // Fold this batch's trades into the tapes, in event order.
      const traded: Pubkey[] = [];
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          if (t.created === null) t.created = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const vq = Number(e.virtual_quote_reserves);
          const vt = Number(e.virtual_token_reserves);
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol: Number(e.sol_amount),
            price: vt <= 0 ? 0 : vq / vt,
          });
          traded.push(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot < now - keep) cut += 1;
        if (cut > 0) t.trades.splice(0, cut);
      }

      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        const m = po.order.mint;
        pendingByMint.set(m, (pendingByMint.get(m) ?? 0) + 1);
      }

      // The account's positions, authoritative after this batch's fills.
      const positions = state.account.positions;

      // ---- Exits first: take profit, stop loss, time limit, whole position. ----
      for (const [mint, h] of held) {
        const pos = positions.find((x) => x.mint === mint);
        if (pos === undefined) {
          // Sold (or flattened by the replay at done): never trade this coin again.
          held.delete(mint);
          retired.add(mint);
          continue;
        }
        if (h.exiting && pendingByMint.has(mint)) continue;
        const curve = state.curves.get(mint);
        const mark = batch.marks.find((m) => m.mint === mint);
        const vq = mark === undefined ? (curve === undefined ? 0n : curve.virtual_quote_reserves)
          : BigInt(mark.virtual_quote_reserves);
        const vt = mark === undefined ? (curve === undefined ? 0n : curve.virtual_token_reserves)
          : BigInt(mark.virtual_token_reserves);
        const net = netSellLamports(BigInt(pos.token_amount), vq, vt, txFee);
        const cost = Number(pos.cost_lamports);
        let fire = false;
        if (net >= cost * p.takeProfit) fire = true;
        else if (net <= cost * p.stopLoss) fire = true;
        else if (now - h.opened >= p.maxHoldSlots) fire = true;
        if (!fire) continue;
        if (orders.length >= cap) break;
        orders.push({
          side: 'sell',
          mint,
          token_amount: pos.token_amount,
          max_slippage_bps: 10_000,
        });
        h.exiting = true;
      }

      // ---- Entries: one small buy per coin passing the momentum filter. ----
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = caps.max_open_positions - state.committedPositionCount();
      const buyLamports = p.buySol * LAMPORTS;
      const minBuyLamports = p.minBuySol * LAMPORTS;

      for (const mint of traded) {
        if (orders.length >= cap || slotsLeft <= 0) break;
        if (held.has(mint) || retired.has(mint) || pendingByMint.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (Number(curve.real_quote_reserves) / LAMPORTS < p.minRqSol) continue;
        const t = tapeOf(mint);
        if (!entrySignal(t, now)) continue;
        let amount = Math.min(buyLamports, Number(state.maxBuyLamports(mint)));
        amount = Math.min(amount, free * LAMPORTS - Number(txFee));
        if (amount < minBuyLamports) continue;
        if (orders.length >= cap) break;
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: BigInt(Math.floor(amount)),
          max_slippage_bps: p.buySlipBps,
        });
        free -= amount / LAMPORTS + Number(txFee) / LAMPORTS;
        slotsLeft -= 1;
        held.set(mint, { opened: now, exiting: false });
      }
      return orders;
    },
  };
};
