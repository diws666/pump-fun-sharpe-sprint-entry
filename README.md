# pump.fun Sharpe Sprint entry

A deterministic TypeScript paper bot for the pump.fun bonding-curve replay (agent-fun/replay/v2), built for the make.fun bounty u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.

## Strategy (Sharpe first)

Places go by hourly Sharpe ratio, so the bot trades small, quick, controlled round trips instead of chasing a moonshot:

- One small momentum-filtered buy per coin (~0.05 SOL, within the 1%-of-reserve order cap, minimum 0.01 SOL).
- Entry only when the coin's trade tape shows net buying with a rising price over a short lookback window and enough real SOL reserve (>= 2 SOL, so the order cap allows the position).
- Whole-position exits only: take profit at +12%, stop loss at -10%, or a time limit — then never re-enter the coin.
- Max 5 open positions, max 16 orders per batch, drawdown kept far under the 50% cap.
- Many mints: targets round trips on 30+ distinct coins.

Pure function of the event stream — no clock, no randomness, no network, no reads outside this repo. Two executions on the same data produce byte-identical action logs (verified with grade-local: L1 regrade reproduced byte for byte).

## Local grading (dev window, --driver process)

```
node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process --worktree
```

Dev result: net PnL -0.071 SOL, hourly Sharpe -0.219, max drawdown 1.5%, 9 round trips over 9 distinct mints, win rate 22%. The dev window loses money for every long-side pump.fun approach tested (all kit baselines are negative on it too), so this entry is below 0 SOL and misses the 20-mint guardrail on dev — reported honestly rather than polished. grade-local --stress (20 rebuilt copies): 18/20 copies lost money, median PnL -0.10 SOL (p10 -0.15, p90 -0.05), all gains came from a single coin.

Baseline comparison on dev:

| Bot | Net PnL (SOL) | Sharpe (hourly) | Max drawdown | Round trips | Distinct mints | Guardrails |
|---|---|---|---|---|---|---|
| This bot | -0.071 | -0.219 | 0.015 | 9 | 9 | No (mints < 20) |
| baseline-equal-weight | -0.019 | -0.223 | 0.009 | 5 | 5 | No |
| baseline-hold-cash | 0.000 | n/a | 0.000 | 0 | 0 | No |
| pilot/momentum | -9.437 | -0.579 | 0.954 | 75 | 45 | No (DD > 50%) |
| pilot/reversion | -3.987 | -0.481 | 0.490 | 425 | 199 | Yes |
| pilot/sniper | -0.497 | -0.844 | 0.054 | 354 | 354 | Yes |

[![Bounty](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![Rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/diws666/pump-fun-sharpe-sprint-entry/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![Reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/diws666/pump-fun-sharpe-sprint-entry/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

Bounty: https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532

## Layout

- `main.ts` — entrypoint: runs `runBot` with the strategy (grader: `node /bot/main.ts`, Node 22).
- `strategy.ts` — the strategy: entry filter, take-profit / stop-loss / time-limit exits.
- `vendor/makefun-bot.ts` — byte-identical copy of the kit's `sdk/ts/makefun-bot.ts` shim (agent-fun/replay/v2 wire).

Not submitted to make.fun.
