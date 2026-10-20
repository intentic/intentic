/* ONE UNIT FOR WHAT A TURN SPENDS, whatever mix of tokens it spent it in. A plan's allowance is not published per token,
   but the providers price the four kinds in fixed ratios to one another (an uncached input token 1, an output token 5, a
   cache read a tenth, a cache write a quarter more), and a meter that weighs them so tracks how fast a window moves
   within about 15% on one account: radarsu's five-hour window took 1.10M and 1.28M of these per point in two intervals
   of 2026-10-20, under different mixes. The ratio only has to be stable, not right: what one point of a window costs in
   this unit is learned per account (burn-rates.ts), so a constant error in the weights cancels out. */

/** A request's or a turn's tokens, each kind optional since not every runtime reports every kind. */
export interface TokenCounts {
    readonly input?: number | undefined;
    readonly output?: number | undefined;
    readonly cacheRead?: number | undefined;
    readonly cacheWrite?: number | undefined;
}

const OUTPUT_WEIGHT = 5;
const CACHE_READ_WEIGHT = 0.1;
const CACHE_WRITE_WEIGHT = 1.25;

/** The tokens in input-token equivalents: what the meter adds up and what a window point is learned against. */
export const weightedTokens = (counts: TokenCounts): number =>
    (counts.input ?? 0) + OUTPUT_WEIGHT * (counts.output ?? 0) + CACHE_READ_WEIGHT * (counts.cacheRead ?? 0) + CACHE_WRITE_WEIGHT * (counts.cacheWrite ?? 0);
