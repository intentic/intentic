/* WHICH SECOND SUBSCRIPTION MAY BE OFFERED TO A REFUSED TURN, and the four ways the answer must be "none".
 *
 * The offer is a one-press promise on the strip that announces the wait: same held turn, another account's
 * pool, no waiting. Every case below is a way that promise could be false, and the reason the honest answer
 * costs nothing: the accounts list carries each account's headroom and seeds the shared map as it lands, so a
 * page load already knows enough to be sure rather than hopeful.
 */
import type { AccountUsage, OauthAccount } from "@intentic/sandbox-contract";
import { beforeEach, expect, it } from "vitest";
import { fallbackAccount, fallbackLabel } from "./limitFallback";
import { providerRefusals, setAccountUsage, usageByAccount } from "./providerAccounts";
import { SPENT_PERCENT } from "./usageStatus";

const account = (id: string, extra: Partial<OauthAccount> = {}): OauthAccount => ({
    id,
    label: id,
    email: `${id}@example.com`,
    connectedAt: 1,
    ...extra,
});

// One five-hour pool at the given fill, gating every model, measured just now. `gates: "all"` is what makes it
// the pool any model is compared against (WindowGatesSchema), which is what usagePercent reads.
const reading = (percent: number): AccountUsage => ({
    windows: [{ kind: `five_hour`, utilization: percent, gates: `all` }],
    measuredAt: Date.now(),
});

const ACCOUNTS = [account(`a`), account(`b`), account(`c`)];

beforeEach(() => {
    usageByAccount.value = {};
    providerRefusals.value = {};
});

// The ordinary case: the turn was refused on `a`, and `b` has been measured with room.
it(`offers a connected account whose own reading has room`, () => {
    setAccountUsage(`claude`, `a`, reading(99));
    setAccountUsage(`claude`, `b`, reading(10));

    expect(fallbackAccount(`claude`, `a`, ACCOUNTS)?.id).toBe(`b`);
});

/* THE ACCOUNT THAT WAS JUST REFUSED IS NEVER THE ANSWER, even while its own last poll still says it has room.
 * Polled readings are a floor and go stale exactly when a pool runs dry, so usageStatusFor folds in what the
 * plan has SINCE refused (spentByRefusal); this asserts the offer rides that correction rather than the raw
 * number. Without it the strip would offer the user the very account that had just turned them away. */
it(`never offers the account a standing refusal names, whatever its last reading said`, () => {
    setAccountUsage(`claude`, `a`, reading(10));
    setAccountUsage(`claude`, `b`, reading(10));
    providerRefusals.value = { claude: { kind: `limit`, account: `b`, at: Date.now(), message: `usage limit reached` } };

    expect(fallbackAccount(`claude`, `a`, ACCOUNTS)?.id).toBeUndefined();
});

/* AN UNMEASURED ACCOUNT IS NOT HEADROOM. This is the case the negative test (`!isSpent`) got wrong: usagePercent
 * is undefined with no reading, so isSpent answers false and an account nobody has ever polled would have been
 * offered as though it were known-good. The press would then spend a round trip to land on the same wall. */
it(`does not offer an account nobody has measured`, () => {
    setAccountUsage(`claude`, `a`, reading(99));

    expect(fallbackAccount(`claude`, `a`, ACCOUNTS)?.id).toBeUndefined();
});

// A credential the provider has stopped accepting is a reconnect prompt, not an allowance: a worse answer than
// the wait it would be replacing.
it(`does not offer an account that needs reconnecting`, () => {
    setAccountUsage(`claude`, `a`, reading(99));
    setAccountUsage(`claude`, `b`, reading(5));

    expect(fallbackAccount(`claude`, `a`, [account(`a`), account(`b`, { needsReauth: true })])?.id).toBeUndefined();
});

// The threshold is the one the rest of the app draws "spent" at, read from usageStatus rather than restated, so
// an account at the boundary is treated the same here as on every meter.
it(`treats the app's own spent threshold as spent`, () => {
    setAccountUsage(`claude`, `a`, reading(99));
    setAccountUsage(`claude`, `b`, reading(SPENT_PERCENT));

    expect(fallbackAccount(`claude`, `a`, ACCOUNTS)?.id).toBeUndefined();

    setAccountUsage(`claude`, `b`, reading(SPENT_PERCENT - 1));
    expect(fallbackAccount(`claude`, `a`, ACCOUNTS)?.id).toBe(`b`);
});

/* EMPTIEST FIRST. The press is made once, in front of somebody who has just been refused, so landing them on
 * the account nearest its own ceiling is how one press becomes three. */
it(`picks the account with the most room, not the first connected`, () => {
    setAccountUsage(`claude`, `a`, reading(99));
    setAccountUsage(`claude`, `b`, reading(70));
    setAccountUsage(`claude`, `c`, reading(12));

    expect(fallbackAccount(`claude`, `a`, ACCOUNTS)?.id).toBe(`c`);
});

// One connection is the common sandbox, and it has no second pool to move to: the strip must show no offer
// rather than an inert button.
it(`offers nothing when the refused account is the only connection`, () => {
    setAccountUsage(`claude`, `a`, reading(99));

    expect(fallbackAccount(`claude`, `a`, [account(`a`)])?.id).toBeUndefined();
});

/* The button has one line to identify a subscription by. The local part is what distinguishes personal
 * addresses, and the label carries a credential that has no identity at all (a pasted key), which is the case
 * renaming exists for. */
it(`names an account by the part of its address a person recognises`, () => {
    expect(fallbackLabel(account(`b`, { email: `radarsu@gmail.com` }))).toBe(`radarsu`);
    expect(fallbackLabel({ id: `x`, label: `Work key`, connectedAt: 1 })).toBe(`Work key`);
});
