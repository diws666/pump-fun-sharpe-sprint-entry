// Pump.fun Sharpe Sprint entry.
//
// Sharpe-first paper bot: small (~0.05 SOL) momentum-filtered buys, whole-position
// exits at +12% take profit / -10% stop loss / time limit, many coins, no re-entry.
//
// The grader runs `node /bot/main.ts`; Node 22 strips the types, so this file and
// strategy.ts run with no build step. The SDK shim (vendor/makefun-bot.ts) is a
// byte-identical copy of the kit's sdk/ts/makefun-bot.ts.
//
// Everything the bot runs is in this repository: no network, no clock, no
// randomness, no reads outside the repo. Deterministic by construction — two
// executions on the same data produce byte-identical action logs.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
