// Pump.fun Sharpe Sprint entry v2.
//
// Sharpe-first paper bot for the agent-fun/replay/v2 pump.fun replay.
//
// v1 lesson: it traded only 9 coins because the entry filter was tight
// (two buys in a 50-slot window, net buying, rising price, >= 2 SOL reserve).
// Guardrails need 20+ distinct mints with round trips of at least 0.01 SOL.
//
// v2 trades a capped number of distinct coins (~30, margin above the 20-mint
// guardrail): small (~0.01 SOL) buys on a momentum entry filter evaluated over
// every coin's tape, whole-position exits at take profit / stop loss / time
// limit, no re-entry. Distinct-coin count is what matters, not trade count, so
// entries are capped once breadth is comfortable. Tiny positions + tight stops
// keep drawdown far under 50%; a moonshot-sized loser is what destroys Sharpe,
// so losers are cut fast.
//
// Deterministic by construction: a pure function of the batch stream, no clock,
// no environment, no Math.random, insertion-ordered maps only.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS = 1_000_000_000;

/** Curve fee on a sell: protocol 95 bps + creator 30 bps fallback. */
const CURVE_FEE_BPS = 125;

export interface Params {
  /** SOL spent per entry buy (adaptive down to the per-mint order cap). */
  buySol: number;
  /** Smallest buy worth sending (round trips must be at least 0.01 SOL). */
  minBuySol: number;
  /** Sell whole position when net proceeds reach this multiple of cost. */
  takeProfit: number;
  /** Sell whole position when net proceeds fall to this multiple of cost. */
  stopLoss: number;
  /** Latest slot a position may be held before a time-limit exit. */
  maxHoldSlots: number;
  /** Min real SOL reserve on the coin so the 1% order cap allows our buy. */
  minRqSol: number;
  /** Tape window in slots for the entry filter. */
  window: number;
  /** Minimum buy trades in the window. */
  minBuys: number;
  /** Minimum net buy SOL (buys minus sells) in the window. */
  minNetSol: number;
  /** Minimum price rise over the window. */
  minPriceUp: number;
  /** Buy slippage tolerance (bps); sells go out at market. */
  buySlipBps: number;
  /** Stop entering new coins once this many distinct round trips are underway. */
  maxEntries: number;
}

export const DEFAULT_PARAMS: Params = {
  buySol: 0.012,
  minBuySol: 0.01,
  takeProfit: 1.06,
  stopLoss: 0.94,
  maxHoldSlots: 300,
  minRqSol: 1,
  window: 200,
  minBuys: 2,
  minNetSol: 0.3,
  minPriceUp: 0.01,
  buySlipBps: 500,
  maxEntries: 30,
};

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;      // lamports
  price: number;    // SOL per token at that trade (virtual quote / virtual token)
}

interface Tape {
  trades: Trade[];
}

interface Held {
  opened: number;   // slot the entry buy was decided on
  exiting: boolean; // a sell order is in flight
  seen: boolean;    // the bought position has appeared in state.account.positions
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  const retired = new Set<Pubkey>(); // coins whose round trip is done
  const keep = Math.max(p.window, p.maxHoldSlots) + 100;
  let entries = 0; // distinct coins entered (capped for breadth vs. Sharpe trade-off)

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { trades: [] };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Entry filter on a coin's tape at slot `now`. Momentum, loosened for breadth. */
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
        if (e.event === 'TradeEvent') {
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
          if (h.seen) {
            // Position was held and is now gone (sell filled / flattened): done with the coin.
            held.delete(mint);
            retired.add(mint);
          }
          // else: position not yet visible after our entry buy; wait for it to appear.
          continue;
        }
        h.seen = true;
        if (h.exiting && pendingByMint.has(mint)) continue;
        const mark = batch.marks.find((m) => m.mint === mint);
        const curve = state.curves.get(mint);
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

      // ---- Entries: small buys on coins passing the momentum filter.
      // Scan every known tape so a coin that qualified while its reserve was
      // still low gets entered once the cap allows. Entries are capped at
      // p.maxEntries: breadth (20+ distinct coins) is the goal, not trade count.
      // ----
      if (entries < p.maxEntries) {
        let free = Number(state.freeCashLamports()) / LAMPORTS;
        let slotsLeft = caps.max_open_positions - state.committedPositionCount();
        const buyLamports = p.buySol * LAMPORTS;
        const minBuyLamports = p.minBuySol * LAMPORTS;

        for (const [mint, t] of tapes) {
          if (entries >= p.maxEntries || orders.length >= cap || slotsLeft <= 0) break;
          if (held.has(mint) || retired.has(mint) || pendingByMint.has(mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          const reserve = Number(curve.real_quote_reserves) / LAMPORTS;
          if (reserve < p.minRqSol) continue;
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
          entries += 1;
          held.set(mint, { opened: now, exiting: false, seen: false });
        }
      }
      return orders;
    },
  };
};
