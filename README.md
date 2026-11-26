# pump.fun Sharpe Sprint entry (v2)

A deterministic TypeScript paper bot for the pump.fun bonding-curve replay (agent-fun/replay/v2), built for the make.fun bounty u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.

## Strategy (Sharpe first)

Places go by hourly Sharpe ratio, so the bot trades small, quick, controlled round trips instead of chasing a moonshot:

- Small momentum-filtered buys (~0.012 SOL per buy, within the 1%-of-reserve order cap, minimum round trip 0.01 SOL).
- Entry filter loosened for breadth: the bot enters 20+ distinct mints on the dev dataset (wider tape window, lower reserve threshold, low buy-trade / net-buy / price-rise thresholds).
- Whole-position exits only: take profit at +6%, stop loss at -6%, or a time limit — then never re-enter the coin.
- Entries are capped once breadth is comfortable (distinct-coin count is what matters, not trade count). Max 5 open positions, max 16 orders per batch, drawdown kept far under the 50% cap.

Pure function of the event stream — no clock, no randomness, no network, no reads outside this repo. Two executions on the same data produce byte-identical action logs (grade-local L1 regrade reproduced byte for byte).

## Local grading (dev window, --driver process)

```sh
node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process --commit <full sha>
```

Run from the kit directory (docker does not run on this machine, so --driver process is used; it is an advisory plausibility check, not the server's verdict).

v2 result on dev: net PnL -0.0069 SOL, hourly Sharpe -0.112, max drawdown 0.0017, 23 round trips over 23 distinct mints, win rate 0.26, 46 fills. Guardrails met (23 >= 20 mints, drawdown << 50%). Sharpe is above v1's -0.219; net PnL is slightly negative (the dev window loses money for every long-side pump.fun approach tested), reported honestly rather than inflated.

grade-local --stress (20 rebuilt block-surrogate copies): median -0.02, p10 -0.03, p90 -0.01 SOL; 20 of 20 copies lost money; the dev score is above 17 of 20 copies.

Baseline comparison on dev (grade-local --driver process):

| Bot | Net PnL (SOL) | Sharpe (hourly) | Max drawdown | Round trips | Distinct mints | Guardrails |
|---|---|---|---|---|---|---|
| This bot (v2) | -0.0069 | -0.112 | 0.0017 | 23 | 23 | Yes |
| baseline-equal-weight | -0.019 | -0.223 | 0.009 | 5 | 5 | No (mints < 20) |
| baseline-hold-cash | 0.000 | n/a | 0.000 | 0 | 0 | No (mints < 20) |

v1 (do not submit): net PnL -0.0708, Sharpe -0.219, 9 round trips over 9 mints — guardrails NOT met (mints < 20).

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/diws666/pump-fun-sharpe-sprint-entry/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/diws666/pump-fun-sharpe-sprint-entry/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

Bounty: https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532

## Layout

- `main.ts` — entrypoint: runs `runBot` with the strategy (grader: `node /bot/main.ts`, Node 22).
- `strategy.ts` — the strategy: entry filter, take-profit / stop-loss / time-limit exits, entry cap for breadth.
- `vendor/makefun-bot.ts` — byte-identical copy of the kit's `sdk/ts/makefun-bot.ts` (md5 2811e0103adc0d2b5201761cfc10f4e2); not modified.

Not submitted to make.fun.
