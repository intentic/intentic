// Pins which account fallbackAccount may offer a refused turn, and every case where it must offer none.
import type { AccountUsage, OauthAccount } from "@intentic/sandbox-contract";
import { beforeEach, expect, it } from "vitest";
import { fallbackAccount, fallbackLabel } from "./limitFallback";
import { providerRefusals, setAccountUsage, usageByAccount } from "../accounts/providerAccounts";
import { SPENT_PERCENT } from "./usageStatus";

const account = (id: string, extra: Partial<OauthAccount> = {}): OauthAccount => ({
    id,
    label: id,
    email: `${id}@example.com`,
    connectedAt: 1,
    ...extra,
});

// Five-hour pool at the given fill; `gates: "all"` makes it the pool usagePercent compares every model against.
const reading = (percent: number): AccountUsage => ({
    windows: [{ kind: `five_hour`, utilization: percent, gates: `all` }],
    measuredAt: Date.now(),
});

const ACCOUNTS = [account(`a`), account(`b`), account(`c`)];

beforeEach(() => {
    usageByAccount.value = {};
    providerRefusals.value = {};
});

it(`offers a connected account whose own reading has room`, () => {
    setAccountUsage(`claude`, `a`, reading(99));
    setAccountUsage(`claude`, `b`, reading(10));

    expect(fallbackAccount(`claude`, `a`, ACCOUNTS)?.id).toBe(`b`);
});

// usageStatusFor folds in providerRefusals (spentByRefusal), so a stale room reading can't override a standing refusal.
it(`never offers the account a standing refusal names, whatever its last reading said`, () => {
    setAccountUsage(`claude`, `a`, reading(10));
    setAccountUsage(`claude`, `b`, reading(10));
    providerRefusals.value = { claude: { kind: `limit`, account: `b`, at: Date.now(), message: `usage limit reached` } };

    expect(fallbackAccount(`claude`, `a`, ACCOUNTS)?.id).toBeUndefined();
});

it(`does not offer an account nobody has measured`, () => {
    setAccountUsage(`claude`, `a`, reading(99));

    expect(fallbackAccount(`claude`, `a`, ACCOUNTS)?.id).toBeUndefined();
});

it(`does not offer an account that needs reconnecting`, () => {
    setAccountUsage(`claude`, `a`, reading(99));
    setAccountUsage(`claude`, `b`, reading(5));

    expect(fallbackAccount(`claude`, `a`, [account(`a`), account(`b`, { needsReauth: true })])?.id).toBeUndefined();
});

it(`treats the app's own spent threshold as spent`, () => {
    setAccountUsage(`claude`, `a`, reading(99));
    setAccountUsage(`claude`, `b`, reading(SPENT_PERCENT));

    expect(fallbackAccount(`claude`, `a`, ACCOUNTS)?.id).toBeUndefined();

    setAccountUsage(`claude`, `b`, reading(SPENT_PERCENT - 1));
    expect(fallbackAccount(`claude`, `a`, ACCOUNTS)?.id).toBe(`b`);
});

it(`picks the account with the most room, not the first connected`, () => {
    setAccountUsage(`claude`, `a`, reading(99));
    setAccountUsage(`claude`, `b`, reading(70));
    setAccountUsage(`claude`, `c`, reading(12));

    expect(fallbackAccount(`claude`, `a`, ACCOUNTS)?.id).toBe(`c`);
});

it(`offers nothing when the refused account is the only connection`, () => {
    setAccountUsage(`claude`, `a`, reading(99));

    expect(fallbackAccount(`claude`, `a`, [account(`a`)])?.id).toBeUndefined();
});

// Second case has no email at all, as a pasted API key would leave it.
it(`names an account by the part of its address a person recognises`, () => {
    expect(fallbackLabel(account(`b`, { email: `radarsu@gmail.com` }))).toBe(`radarsu`);
    expect(fallbackLabel({ id: `x`, label: `Work key`, connectedAt: 1 })).toBe(`Work key`);
});
