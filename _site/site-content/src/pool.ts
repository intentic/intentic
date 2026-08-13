/* THE PUBLISHED POOL FIGURES: the membership price, the daily credit allowance, what installing a premium
 * extension donates, and the share a spent credit pays its creator. Mirrored from the platform's own defaults
 * (_platform/api/src/config.ts, the `pool` block) so the site states one set of numbers from one place instead
 * of retyping them into every page that mentions money.
 *
 * WHAT IS DERIVED IS NOT WRITTEN. Everything below the four published figures is computed from them: a
 * credit's value, a month's allowance, how many installs or service runs a day's credits buy. Those are
 * exactly the numbers that rot in silence: a sentence reading "five installs a day" stays on the page long
 * after the 200 that made it true has moved, and nothing fails to warn anybody. Written once as arithmetic,
 * they cannot disagree with the figures they come from.
 *
 * A credit's value is priced the platform's own way (pool-share.ts `creditCents`: priceUsd over thirty days of
 * allowance) rather than by a second derivation invented here, because that value is the hinge the whole model
 * turns on: it is what makes a member's total support bounded by what they actually paid.
 *
 * The live numbers are published by the platform itself on GET /pool/transparency, and that ledger is what
 * payouts settle on. This module is what a static page can state without a backend behind it. */

// The five figures the platform publishes. Change one here and every derived number below follows.
export const pool = {
    // The membership's monthly price in USD.
    priceUsd: 20,
    /* What running the platform for one member costs — their hosted machine and its disk, above all — taken
     * off the price BEFORE the shares below apply. Published rather than absorbed silently, because it is
     * the base the 90% is 90% OF, and a share whose base a reader cannot see is not a disclosure. */
    infraUsd: 5,
    // A member's daily credit allowance, reset at UTC midnight.
    dailyCredits: 1000,
    // What installing or, at most monthly, updating a premium extension donates to its publisher. Flat
    // across the catalog on purpose: a price a listing could set would be the first number anyone games.
    donationCredits: 200,
    // The fraction of a spent credit's value its recipient earns, for both donations and service runs.
    creatorShare: 0.9,
} as const;

// The month the credit value is derived over, matching the platform's own arithmetic.
const DAYS = 30;

// What is actually shared: the membership after infrastructure. Every figure below is derived from THIS
// rather than from the price, exactly as the platform derives them, so no page can quote a share of a number
// the pool never contained.
export const poolUsd = pool.priceUsd - pool.infraUsd;

// A month's allowance: the ceiling on what one member can possibly spend, and so on what they can possibly
// direct to creators. Local: it exists to price a credit, and every reader-facing figure below is derived.
const monthlyCredits = pool.dailyCredits * DAYS;

// How many credits go to a cent. Stated this way round because a credit is worth well under one, and "20 to
// the cent" is a number a reader can hold where "$0.0005" is one they skip.
export const creditsPerCent = Math.round(monthlyCredits / (poolUsd * 100));

// The creator share as whole percent, for copy that says "90%".
export const creatorSharePct = Math.round(pool.creatorShare * 100);

// A day's credits as premium installs.
export const installsPerDay = Math.floor(pool.dailyCredits / pool.donationCredits);

// A day's credits as runs of a service at `creditsPerRun`.
export const runsPerDay = (creditsPerRun: number): number => Math.floor(pool.dailyCredits / creditsPerRun);

/* The demo service the platform hosts itself (pool-demo.ts): the one service whose price the site can quote
 * without a backend read, and the honest example: a real provider sets its own, and every surface shows it
 * before the run. Named for what it is so no page can pass it off as a catalog-wide rate. */
export const demoServiceCredits = 5;
