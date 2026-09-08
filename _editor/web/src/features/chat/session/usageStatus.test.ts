import type { AccountUsage, OauthAccount, ProviderRefusal, TranslatorAccounts, UsageWindow } from "@intentic/sandbox-contract";
import { afterEach, describe, expect, it } from "vitest";
import { providerAccounts, providerRefusals, translatorAccounts, usageByAccount } from "../accounts/providerAccounts";
import {
    bindingWindow,
    formatAge,
    formatReset,
    formatUtilization,
    formatWait,
    isSpent,
    isStale,
    liveUsage,
    modelAllowance,
    orderedWindows,
    planLimitBand,
    planLimitGroups,
    type PlanLimitRow,
    planLimitRows,
    planLimitSummary,
    type PlanHeadroom,
    planHeadroom,
    refusalNote,
    type RefusalReading,
    usageDetail,
    usagePercent,
    usageStatusFor,
    usageWindowLabel,
} from "./usageStatus";

const window = (over: Partial<UsageWindow> = {}): UsageWindow => ({ kind: `seven_day`, utilization: 42.4, gates: `all`, ...over });
const usage = (over: Partial<AccountUsage> = {}): AccountUsage => ({ windows: [window()], measuredAt: 0, ...over });
// Unwraps planHeadroom since these tests always have a reading; the undefined case is tested separately below.
const headroom = (over: Partial<AccountUsage> = {}): PlanHeadroom => {
    const projected = planHeadroom(usage(over));
    if (projected === undefined) {
        throw new Error(`a measured account always projects`);
    }
    return projected;
};

describe(`usageWindowLabel`, () => {
    it(`keeps every weekly pool distinguishable, folding them is the bug it exists to prevent`, () => {
        const kinds = [`five_hour`, `seven_day`, `seven_day_opus`, `seven_day_oauth_apps`] as const;
        const labels = kinds.map((kind) => usageWindowLabel(window({ kind })));
        expect(new Set(labels).size).toBe(kinds.length);
        expect(usageWindowLabel(window({ kind: `five_hour` }))).toContain(`5-hour`);
        expect(usageWindowLabel(window({ kind: `seven_day` }))).toContain(`Weekly`);
        expect(usageWindowLabel(window({ kind: `seven_day_opus` }))).toContain(`Opus`);
        expect(usageWindowLabel(window({ kind: `seven_day_oauth_apps` }))).toContain(`third-party`);
    });

    it(`prefers the provider's own name for a per-model pool`, () => {
        expect(usageWindowLabel(window({ kind: `model:Fable`, label: `Fable` }))).toBe(`Weekly · Fable`);
    });

    it(`uses a non-Claude provider's complete label without incorrectly calling it weekly`, () => {
        expect(usageWindowLabel(window({ kind: `google:pro-five-hour`, label: `Gemini Pro · 5-hour` }))).toBe(`Gemini Pro · 5-hour`);
    });

    it(`shows an unrecognised pool under its raw key rather than folding it into a neighbour`, () => {
        expect(usageWindowLabel(window({ kind: `thirty_day_experimental` }))).toBe(`thirty_day_experimental`);
    });
});

describe(`orderedWindows`, () => {
    it(`puts the soonest-biting pool first and the broad weekly one ahead of the per-model ones`, () => {
        const ordered = orderedWindows(
            usage({
                windows: [
                    window({ kind: `model:Fable`, label: `Fable` }),
                    window({ kind: `seven_day_opus` }),
                    window({ kind: `seven_day` }),
                    window({ kind: `five_hour` }),
                ],
            }),
        );
        expect(ordered.map((entry) => entry.kind)).toEqual([`five_hour`, `seven_day`, `seven_day_opus`, `model:Fable`]);
    });
});

describe(`bindingWindow`, () => {
    it(`is the FULLEST pool, the account is as constrained as its tightest allowance`, () => {
        const picked = bindingWindow(
            usage({ windows: [window({ kind: `five_hour`, utilization: 12 }), window({ kind: `seven_day`, utilization: 98 })] }),
        );
        expect(picked?.kind).toBe(`seven_day`);
    });

    it(`is the fullest pool the MODEL spends when the surface knows one: a spent Opus slice is not Haiku's ceiling`, () => {
        const reading = usage({
            windows: [window({ kind: `seven_day`, utilization: 30 }), window({ kind: `model:Opus`, label: `Opus`, utilization: 100, gates: { models: [`Opus`] } })],
        });
        expect(bindingWindow(reading, { id: `claude-haiku-4-5` })?.kind).toBe(`seven_day`);
        expect(bindingWindow(reading, { id: `claude-opus-4-6` })?.kind).toBe(`model:Opus`);
        expect(usagePercent(reading, { id: `claude-haiku-4-5` })).toBe(30);
        expect(isSpent(reading, { id: `claude-haiku-4-5` })).toBe(false);
        expect(isSpent(reading, { id: `claude-opus-4-6` })).toBe(true);
    });

    it(`is undefined when no pool was reported, so a row reads unknown rather than 0%`, () => {
        expect(bindingWindow(undefined)).toBeUndefined();
        expect(bindingWindow(usage({ windows: [] }))).toBeUndefined();
    });
});

describe(`usagePercent`, () => {
    it(`rounds the binding pool's utilization`, () => {
        expect(usagePercent(usage({ windows: [window({ utilization: 42.4 })] }))).toBe(42);
        expect(usagePercent(usage({ windows: [window({ utilization: 0 })] }))).toBe(0);
    });

    it(`is undefined when nothing was measured`, () => {
        expect(usagePercent(undefined)).toBeUndefined();
        expect(usagePercent(usage({ windows: [] }))).toBeUndefined();
    });
});

describe(`formatAge`, () => {
    const now = 1_000_000_000_000;
    it(`coarsens the snapshot's age so a persisted reading never reads as live`, () => {
        expect(formatAge(now - 30_000, now)).toBe(`just now`);
        expect(formatAge(now - 15 * 60_000, now)).toBe(`15m ago`);
        expect(formatAge(now - 3 * 3_600_000, now)).toBe(`3h ago`);
        expect(formatAge(now - 2 * 86_400_000, now)).toBe(`2d ago`);
    });
    it(`never overstates how fresh a reading is`, () => {
        expect(formatAge(now - 119 * 60_000, now)).toBe(`1h ago`);
        expect(formatAge(now - 59_000, now)).toBe(`just now`);
    });
});

describe(`isStale / formatUtilization`, () => {
    const now = 1_000_000_000_000;
    it(`turns an overtaken reading into a floor rather than a figure`, () => {
        expect(isStale(usage({ measuredAt: now - 60_000 }), now)).toBe(false);
        expect(isStale(usage({ measuredAt: now - 8 * 3_600_000 }), now)).toBe(true);
        expect(formatUtilization(98, false)).toBe(`98%`);
        expect(formatUtilization(98, true)).toBe(`≥98%`);
    });

    it(`never marks a spent pool as a floor, however old the reading is`, () => {
        expect(formatUtilization(100, true)).toBe(`100%`);
        expect(formatUtilization(99, true)).toBe(`≥99%`);
    });
});

// Sentence a screen reader hears instead of the card (UsageRing.vue draws the sighted list of meters). Pins
// that the spoken version still carries every fact the card shows.
describe(`usageDetail`, () => {
    it(`lists EVERY pool, because which one is binding is what a single number can't say`, () => {
        const measuredAt = Date.now();
        const projected = headroom({
            windows: [window({ kind: `five_hour`, utilization: 12 }), window({ kind: `seven_day`, utilization: 98 })],
            measuredAt,
        });
        const detail = usageDetail(projected);
        for (const pool of projected.pools) {
            expect(detail).toContain(`${pool.label} ${formatUtilization(pool.percent, projected.stale)}`);
        }
        expect(detail).toContain(formatAge(measuredAt));
        expect(detail).toContain(`12%`);
        expect(detail).toContain(`98%`);
    });

    it(`names each pool's reset beside its figure, "wait 20 minutes" and "wait until Thursday" are different answers`, () => {
        const resetsAt = 1_700_000_000;
        const measuredAt = Date.now();
        const projected = headroom({
            windows: [window({ kind: `five_hour`, utilization: 91, resetsAt }), window({ kind: `seven_day`, utilization: 40 })],
            measuredAt,
        });
        const detail = usageDetail(projected);
        expect(detail).toContain(formatReset(resetsAt));
        expect(detail).toContain(`91%`);
        expect(detail).toContain(`40%`);
        expect(detail).toContain(formatAge(measuredAt));
    });

    it(`marks every figure as a floor once the reading is old enough to have been overtaken elsewhere`, () => {
        const measuredAt = Date.now() - 8 * 3_600_000;
        const projected = headroom({ windows: [window({ kind: `seven_day`, utilization: 1 })], measuredAt });
        const detail = usageDetail(projected);
        expect(detail).toContain(formatUtilization(1, true));
        expect(detail).toContain(usageWindowLabel(window({ kind: `seven_day` })));
        expect(detail).toContain(formatAge(measuredAt));
    });
});

// Outage retry's wait: seconds to minutes out, where a wall clock would misreport. Deliberately coarse —
// the daemon's own schedule has jitter.
describe(`formatWait`, () => {
    const now = 1_000_000_000;

    it(`reads as seconds for a short wait, rounded so it never looks second-accurate`, () => {
        expect(formatWait(now / 1000 + 30, now)).toBe(`about 30s`);
        expect(formatWait(now / 1000 + 32, now)).toBe(`about 30s`);
    });

    it(`switches to minutes once seconds stop being useful`, () => {
        expect(formatWait(now / 1000 + 300, now)).toBe(`about 5 min`);
        expect(formatWait(now / 1000 + 1_200, now)).toBe(`about 20 min`);
    });

    it(`never counts backwards past zero, a due-but-unfired retry reads as imminent, not overdue`, () => {
        expect(formatWait(now / 1000 - 60, now)).toBe(`about 5s`);
    });
});

// The account row's ring and card. Pins the projection's meaning once, since the Agent tab, picker and
// composer all read it the same way.
describe(`planHeadroom`, () => {
    it(`renders no ring at all for an account nobody has measured`, () => {
        expect(planHeadroom(undefined)).toBeUndefined();
    });

    it(`reads a spent account as a full red ring rather than a healthy dot`, () => {
        const spent = headroom({ windows: [window({ kind: `google:weekly`, utilization: 100 })] });
        expect(spent.percent).toBe(100);
        expect(spent.tone).toBe(`text-danger`);
    });

    it(`treats a fully reset account as 0%, not as unknown`, () => {
        const reset = headroom({ windows: [] });
        expect(reset.percent).toBe(0);
        expect(reset.tone).toBe(`text-link`);
        expect(reset.binding).toBeUndefined();
    });

    it(`carries every pool, with the one that bites first named as the binding one`, () => {
        const mixed = headroom({
            windows: [window({ kind: `five_hour`, utilization: 12 }), window({ kind: `seven_day`, utilization: 91, resetsAt: 1_700_000_000 })],
        });
        expect(mixed.percent).toBe(91);
        expect(mixed.binding).toEqual({ kind: `seven_day`, label: `Weekly · all models`, percent: 91, resetsAt: 1_700_000_000, gates: `all` });
        expect(mixed.pools.map((pool) => pool.label)).toEqual([`5-hour session`, `Weekly · all models`]);
    });
});

describe(`modelAllowance`, () => {
    // Named per-model pools, scoped and labeled the way Claude's own reader tags a tier.
    const scoped = (...names: readonly string[]): AccountUsage =>
        usage({
            windows: [
                window({ kind: `five_hour`, utilization: 1 }),
                ...names.map((name, index) => window({ kind: `model:${name}`, label: name, utilization: index + 2, gates: { models: [name] } })),
            ],
        });

    it(`matches the plan's name for a model against the vendor's id and label alike`, () => {
        const opus = scoped(`Opus`, `Sonnet`);
        expect(modelAllowance(opus, { id: `claude-opus-4-6`, label: `Claude Opus 4.6` })?.name).toBe(`Opus`);
        expect(modelAllowance(opus, { id: `claude-sonnet-4-6`, label: `Claude Sonnet 4.6` })?.name).toBe(`Sonnet`);
    });

    it(`carries the pool's own figures, so the sentence and the meter can't disagree`, () => {
        const reading = usage({ windows: [window({ kind: `model:Fable`, label: `Fable`, utilization: 94.4, resetsAt: 1_700_000, gates: { models: [`Fable`] } })] });
        expect(modelAllowance(reading, { id: `claude-fable-5`, label: `Claude Fable 5` })).toEqual({ name: `Fable`, percent: 94, resetsAt: 1_700_000 });
    });

    it(`says nothing for a plan that doesn't meter this model on its own`, () => {
        expect(modelAllowance(usage({ windows: [window({ kind: `five_hour` }), window({ kind: `seven_day` })] }), { id: `claude-opus-4-6` })).toBeUndefined();
        expect(modelAllowance(scoped(`Opus`), { id: `grok-4-fast`, label: `Grok 4 Fast` })).toBeUndefined();
        expect(modelAllowance(undefined, { id: `claude-opus-4-6`, label: `Claude Opus 4.6` })).toBeUndefined();
    });

    it(`names a Google family pool for the model it gates, in the provider's own words`, () => {
        const google = usage({
            windows: [window({ kind: `google:3p-weekly`, label: `Claude and GPT models · Weekly Limit`, utilization: 73, gates: { models: [`claude`, `gpt`] } })],
        });
        expect(modelAllowance(google, { id: `claude-opus-4-6-thinking` })?.name).toBe(`Claude and GPT models · Weekly Limit`);
        expect(modelAllowance(google, { id: `gemini-3-pro` })).toBeUndefined();
    });

    it(`prefers the more specific pool, and answers nothing when two are equally specific`, () => {
        // scoped('Opus', 'Claude Opus') has a specific match; scoped('Opus', 'Claude') ties, so neither wins.
        expect(modelAllowance(scoped(`Opus`, `Claude Opus`), { id: `claude-opus-4-6`, label: `Claude Opus 4.6` })?.name).toBe(`Claude Opus`);
        expect(modelAllowance(scoped(`Opus`, `Claude`), { id: `claude-opus-4-6`, label: `Claude Opus 4.6` })).toBeUndefined();
    });
});

// One definition of "spent", shared by the ring's colour, the row's dimming and the list's sort order.
describe(`isSpent`, () => {
    it(`is false for an account with no reading, unknown is not exhausted`, () => {
        expect(isSpent(undefined)).toBe(false);
    });

    it(`agrees with the ring's own danger tone at the boundary`, () => {
        const at = usage({ windows: [window({ utilization: 90 })] });
        const below = usage({ windows: [window({ utilization: 89 })] });
        expect([isSpent(at), planHeadroom(at)?.tone]).toEqual([true, `text-danger`]);
        expect([isSpent(below), planHeadroom(below)?.tone]).toEqual([false, `text-warning`]);
    });
});

// Which reading an account row draws: the shared map (usageByAccount) when it has an entry, else the row's
// own attached reading.
describe(`liveUsage`, () => {
    afterEach(() => {
        usageByAccount.value = {};
    });

    it(`keeps a row's own reading when the map holds nothing for that account`, () => {
        const attached = usage({ measuredAt: 500 });
        expect(liveUsage(`gemini`, `gemini-account`, attached)).toBe(attached);
    });

    it(`reads the map wherever it has an entry, whichever source wrote it`, () => {
        const streamed = usage({ measuredAt: 900 });
        usageByAccount.value = { "claude:claude-1": streamed };
        // toEqual, not toBe: the shared store is a Vue ref, so what comes back is its reactive proxy.
        expect(liveUsage(`claude`, `claude-1`, usage({ measuredAt: 500 }))).toEqual(streamed);
        expect(liveUsage(`claude`, `claude-1`)).toEqual(streamed);
    });

    it(`finds a routed subscription under its provider-qualified key`, () => {
        const pulled = usage({ measuredAt: 100 });
        usageByAccount.value = { "gemini:g-1": pulled };
        expect(liveUsage(`gemini`, `g-1`)).toEqual(pulled);
        expect(liveUsage(`kimi`, `g-1`)).toBeUndefined();
    });
});

// A refusal outweighs the reading it contradicts: the pool that refused is the one whose polled reading also
// freezes, short of 100%.
describe(`liveUsage under a standing refusal`, () => {
    const refusedFor = (over: Partial<ProviderRefusal> = {}): ProviderRefusal => ({
        at: 1_000,
        kind: `limit`,
        message: `weekly limit reached`,
        account: `claude-1`,
        ...over,
    });
    const spent = (over: Partial<ProviderRefusal> = {}): Record<string, ProviderRefusal> => ({ claude: refusedFor(over) });
    // Two pools, so what is pinned can be told apart from what is left alone.
    const pools = (over: Partial<AccountUsage> = {}): AccountUsage =>
        usage({ windows: [window({ kind: `five_hour`, utilization: 40 }), window({ kind: `seven_day`, utilization: 99.2 })], ...over });
    const percentsOf = (reading: AccountUsage | undefined): (number | undefined)[] =>
        (reading?.windows ?? []).map((entry) => entry.utilization);

    // Resets both connection stores; a leaked row from another test would count as another account.
    const noRouted: TranslatorAccounts = { codex: [], grok: [], kimi: [], gemini: [] };
    afterEach(() => {
        providerRefusals.value = {};
        providerAccounts.value = { ...providerAccounts.value, claude: [] };
        translatorAccounts.value = noRouted;
    });

    it(`reads the pool that refused as full, not as the floor the last reading left behind`, () => {
        providerRefusals.value = spent();
        // The reading (measuredAt 500) predates the refusal (at 1000), the ordinary case.
        expect(percentsOf(liveUsage(`claude`, `claude-1`, pools({ measuredAt: 500 })))).toEqual([40, 100]);
        const projected = planHeadroom(liveUsage(`claude`, `claude-1`, pools({ measuredAt: 500 })));
        expect(formatUtilization(projected?.percent ?? 0, true)).toBe(`100%`);
    });

    it(`pins only the pool that was binding, the others keep their own readings`, () => {
        providerRefusals.value = spent();
        const pinned = liveUsage(`claude`, `claude-1`, pools({ measuredAt: 500 }));
        expect(pinned?.windows.find((entry) => entry.kind === `five_hour`)?.utilization).toBe(40);
        expect(pinned?.measuredAt).toBe(500);
    });

    it(`says nothing about a sibling the refusal did not name, nor about another provider at all`, () => {
        providerRefusals.value = spent();
        const other = pools({ measuredAt: 500 });
        expect(liveUsage(`claude`, `claude-2`, other)).toBe(other);
        // Keyed by provider: Claude's refusal can't reach `claude-1` filed under a different provider (kimi).
        expect(liveUsage(`kimi`, `claude-1`, other)).toBe(other);
    });

    it(`is the spent-allowance refusal alone: a credential or a seat says nothing about a pool`, () => {
        const reading = pools({ measuredAt: 500 });
        providerRefusals.value = spent({ kind: `auth`, message: `401` });
        expect(liveUsage(`claude`, `claude-1`, reading)).toBe(reading);
        providerRefusals.value = spent({ kind: `entitlement`, message: `disabled for this seat` });
        expect(liveUsage(`claude`, `claude-1`, reading)).toBe(reading);
    });

    it(`lets go the moment a reading taken since finds room, the rule that settles the note beside it`, () => {
        providerRefusals.value = spent();
        const reopened = usage({ windows: [window({ utilization: 12 })], measuredAt: 2_000 });
        expect(liveUsage(`claude`, `claude-1`, reopened)).toBe(reopened);
        // Measured since and still spent is the refusal being confirmed, not answered.
        expect(percentsOf(liveUsage(`claude`, `claude-1`, pools({ measuredAt: 2_000 })))).toEqual([40, 100]);
    });

    // Routed refusal names nobody; it speaks for every connection the provider holds.
    const kimiPools = (over: Partial<AccountUsage> = {}): AccountUsage =>
        usage({ windows: [window({ kind: `five_hour`, utilization: 93 }), window({ kind: `seven_day`, utilization: 79 })], ...over });
    const kimiSpent = { kimi: { at: 2_000, kind: `limit` as const, message: `403 You've reached your 5-hour usage limit` } };

    it(`reads a routed subscription as spent on the refusal that could name nobody`, () => {
        const reading = kimiPools({ measuredAt: 1_500 });
        translatorAccounts.value = { ...noRouted, kimi: [{ name: `kimi-1`, label: `Kimi Code session`, usage: reading }] };
        providerRefusals.value = kimiSpent;
        expect(percentsOf(liveUsage(`kimi`, `kimi-1`, reading))).toEqual([100, 79]);
    });

    it(`is answered for the whole provider by any one of its connections having room since`, () => {
        const reading = kimiPools({ measuredAt: 1_500 });
        translatorAccounts.value = {
            ...noRouted,
            kimi: [
                { name: `kimi-1`, label: `Kimi Code session`, usage: reading },
                { name: `kimi-2`, label: `Kimi spare`, usage: usage({ windows: [window({ utilization: 20 })], measuredAt: 3_000 }) },
            ],
        };
        providerRefusals.value = kimiSpent;
        // toEqual, not toBe: the rows seeded the shared map, and what comes back is its reactive proxy.
        expect(liveUsage(`kimi`, `kimi-1`, reading)).toEqual(reading);
    });

    // Judged on raw readings, not the pinned ones; a pin can't keep confirming its own refusal forever.
    it(`cannot keep itself standing, the verdict is the same on the pinned figure as on the raw one`, () => {
        const refusal = refusedFor();
        const verdict = (percent: number): boolean | undefined =>
            refusalNote(refusal, [{ account: `claude-1`, measuredAt: 2_000, percent, needsReauth: false }], 5_000)?.current;
        expect(verdict(99)).toBe(true);
        expect(verdict(100)).toBe(true);
    });
});

// Same merge as liveUsage, for callers holding only an account id: the composer chip, picker rows, a
// refused-turn sentence.
describe(`usageStatusFor`, () => {
    afterEach(() => {
        usageByAccount.value = {};
    });

    it(`finds the daemon's reading on whichever list the account is on`, () => {
        providerAccounts.value = { ...providerAccounts.value, claude: [{ id: `claude-1`, label: `Claude`, connectedAt: 0, usage: usage() }] };
        translatorAccounts.value = { ...translatorAccounts.value, gemini: [{ name: `g-1`, label: `Google`, usage: usage({ measuredAt: 7 }) }] };

        expect(usageStatusFor(`claude`, `claude-1`)?.measuredAt).toBe(0);
        // A routed subscription is keyed by its auth-file name, the key its row is drawn under.
        expect(usageStatusFor(`gemini`, `g-1`)?.measuredAt).toBe(7);
        expect(usageStatusFor(`claude`, `nobody`)).toBeUndefined();
        expect(usageStatusFor(`claude`, undefined)).toBeUndefined();
        // Scoped to the asked provider; the same account name under a different provider wouldn't collide.
        expect(usageStatusFor(`kimi`, `claude-1`)).toBeUndefined();
    });

    it(`reads a turn's own frame once it has been written, the map being seeded from the rows and then kept newest`, () => {
        providerAccounts.value = { ...providerAccounts.value, claude: [{ id: `claude-1`, label: `Claude`, connectedAt: 0, usage: usage() }] };
        usageByAccount.value = { ...usageByAccount.value, "claude:claude-1": usage({ measuredAt: 900 }) };
        expect(usageStatusFor(`claude`, `claude-1`)?.measuredAt).toBe(900);
        usageByAccount.value = {};
    });
});

// The Usage tab's meters. Guards coverage: both native and routed accounts must appear, including a reading
// attached directly to the row rather than only the streamed map.
describe(`planLimitRows`, () => {
    const account = (over: Partial<OauthAccount> = {}): OauthAccount => ({ id: `claude-1`, label: `Claude`, connectedAt: 0, ...over });
    const noRouted: TranslatorAccounts = { codex: [], grok: [], kimi: [], gemini: [] };

    it(`draws a routed subscription's pulled reading, not just the native accounts`, () => {
        const rows = planLimitRows(
            {},
            { ...noRouted, gemini: [{ name: `antigravity-1`, label: `someone@gmail.com`, usage: usage({ measuredAt: 500 }) }] },
        );
        expect(rows.map((row) => [row.provider, row.label, row.percent])).toEqual([[`gemini`, `someone@gmail.com`, 42]]);
    });

    it(`lists an account with no reading and says which kind of nothing it is`, () => {
        // Kimi is now read like ChatGPT/Google (readable: true); SuperGrok is the one plan that publishes no limits
        // at all (readable: false).
        const rows = planLimitRows(
            { claude: [account({ usage: usage() })] },
            { ...noRouted, grok: [{ name: `xai-1`, label: `SuperGrok` }], kimi: [{ name: `kimi-1`, label: `Kimi Code` }] },
        );
        expect(rows.map((row) => [row.label, row.percent, row.readable, row.pools.length])).toEqual([
            [`Claude`, 42, true, 1],
            [`Kimi Code`, undefined, true, 0],
            [`SuperGrok`, undefined, false, 0],
        ]);
    });

    it(`sinks an unmeasured account below every measured one: unknown is not headroom`, () => {
        const rows = planLimitRows(
            {
                claude: [
                    account({ id: `unmeasured`, label: `Never ran` }),
                    account({ id: `busy`, label: `Nearly spent`, usage: usage({ windows: [window({ utilization: 98 })] }) }),
                    account({ id: `idle`, label: `Plenty left`, usage: usage({ windows: [window({ utilization: 4 })] }) }),
                ],
            },
            noRouted,
        );
        expect(rows.map((row) => row.label)).toEqual([`Nearly spent`, `Plenty left`, `Never ran`]);
    });

    it(`keys rows by provider and account, so two providers' auth files can't collide`, () => {
        const rows = planLimitRows(
            {},
            { ...noRouted, codex: [{ name: `default`, label: `ChatGPT` }], kimi: [{ name: `default`, label: `Kimi Code` }] },
        );
        expect(rows.map((row) => row.id)).toEqual([`codex:default`, `kimi:default`]);
    });

    it(`draws the map's reading over the account row it arrived with`, () => {
        usageByAccount.value = { "claude:claude-1": usage({ windows: [window({ utilization: 96 })], measuredAt: 900 }) };
        const rows = planLimitRows({ claude: [account({ usage: usage({ measuredAt: 500 }) })] }, noRouted);
        expect(rows[0]?.percent).toBe(96);
        usageByAccount.value = {};
    });

    it(`carries the translator's own bench of a routed credential onto its row`, () => {
        const rows = planLimitRows({}, { ...noRouted, kimi: [{ name: `kimi-1`, label: `Kimi Code`, cooling: { until: 9_000, reason: `quota exceeded` } }] });
        expect(rows[0]?.cooling).toEqual({ until: 9_000, reason: `quota exceeded` });
    });
});

// The aggregate a row list can't answer past dozens of accounts: how much of the fleet can run, where, and
// what's broken.
describe(`plan-limit aggregates`, () => {
    const at = (percent: number | undefined, over: Partial<PlanLimitRow> = {}): PlanLimitRow => ({
        id: `claude:${percent ?? `none`}`,
        provider: `claude`,
        account: `${percent ?? `none`}`,
        label: `account`,
        identity: undefined,
        percent,
        pools: percent === undefined ? [] : [{ kind: `seven_day`, label: `Weekly`, percent, resetsAt: 5_000, gates: `all` }],
        binding: percent === undefined ? undefined : { kind: `seven_day`, label: `Weekly`, percent, resetsAt: 5_000, gates: `all` },
        measuredAt: percent === undefined ? undefined : 0,
        stale: false,
        readable: true,
        needsReauth: false,
        routed: false,
        cooling: undefined,
        ...over,
    });

    it(`bands on the same two thresholds the meters wear, and keeps the two kinds of "no reading" apart`, () => {
        expect(at(89).percent).toBe(89);
        expect([planLimitBand(at(90)), planLimitBand(at(89)), planLimitBand(at(75)), planLimitBand(at(74))]).toEqual([
            `spent`,
            `tight`,
            `tight`,
            `room`,
        ]);
        expect(planLimitBand(at(undefined))).toBe(`unread`);
        expect(planLimitBand(at(undefined, { readable: false }))).toBe(`none`);
    });

    it(`groups by provider, most-constrained provider first, with an unread provider last`, () => {
        const groups = planLimitGroups([
            at(20, { id: `a`, provider: `gemini` }),
            at(undefined, { id: `b`, provider: `kimi`, readable: false }),
            at(95, { id: `c`, provider: `claude` }),
        ]);
        expect(groups.map((group) => group.provider)).toEqual([`claude`, `gemini`, `kimi`]);
        expect(groups[0]?.tightest?.id).toBe(`c`);
        expect(groups[2]?.counts.none).toBe(1);
    });

    it(`names the soonest pool still ahead of us, never one that has already reopened`, () => {
        const past = at(30, { id: `past`, pools: [{ kind: `five_hour`, label: `5-hour`, percent: 30, resetsAt: 1_000, gates: `all` }] });
        const future = at(40, { id: `future`, pools: [{ kind: `seven_day`, label: `Weekly`, percent: 40, resetsAt: 9_000, gates: `all` }] });
        // now = 5s in epoch ms ⇒ the 1,000s reset is behind us and the 9,000s one is not.
        expect(planLimitSummary([past, future], 5_000_000).nextResetAt).toBe(9_000);
        expect(planLimitSummary([past], 5_000_000).nextResetAt).toBeUndefined();
    });

    // A stored refusal can outlive its own truth for a week; the record existing doesn't mean it's current.
    it(`hands each provider its own last refusal, and points it at the account it names`, () => {
        const message = `You've reached your usage limit`;
        const refusals = { kimi: { at: 1_000, kind: `limit` as const, message, account: `20` } };
        const groups = planLimitGroups([at(20, { id: `k`, provider: `kimi` }), at(95, { id: `c` })], refusals, 5_000);
        expect(groups.find((group) => group.provider === `claude`)?.refusal).toBeUndefined();
        const kimiRefusal = groups.find((group) => group.provider === `kimi`)?.refusal;
        expect(kimiRefusal?.line).toContain(message);
        expect(kimiRefusal?.line).toContain(formatAge(1_000, 5_000));
        expect(kimiRefusal?.current).toBe(true);
        expect(groups[1]?.refusedRow?.id).toBe(`k`);
    });

    // Headroom answers a spent pool, a working credential answers a rejected one — and only from the same account.
    const reading = (over: Partial<RefusalReading> = {}): RefusalReading => ({
        account: `a`,
        measuredAt: 2_000,
        percent: 3,
        needsReauth: false,
        ...over,
    });

    it(`keeps a spent-pool refusal standing until a reading taken since finds headroom`, () => {
        const refusal = { at: 1_000, kind: `limit` as const, message: `spent` };
        const current = (readings: RefusalReading[]): boolean | undefined => refusalNote(refusal, readings, 5_000)?.current;
        // Nothing measured at all, and a reading from before the refusal: neither can contradict it.
        expect(current([])).toBe(true);
        expect(current([reading({ measuredAt: 500 })])).toBe(true);
        // Measured since, and still spent: the refusal is exactly what that pool is saying.
        expect(current([reading({ percent: 99 })])).toBe(true);
        // Measured since, with room: the pool reopened and the refusal is history.
        expect(current([reading()])).toBe(false);
        expect(refusalNote(undefined, [], 5_000)).toBeUndefined();
    });

    it(`answers a rejected credential with the named account's own sign-in, not a sibling's percentage`, () => {
        const refusal = { at: 1_000, kind: `auth` as const, message: `401 OAuth access token has been revoked.`, account: `a` };
        const current = (readings: RefusalReading[]): boolean | undefined => refusalNote(refusal, readings, 5_000)?.current;
        // Sibling account b reads fine; the named account a's own reading predates the refusal — neither answers it.
        expect(current([reading({ account: `b` }), reading({ measuredAt: 500 })])).toBe(true);
        // Named account a reads since: the credential itself worked, proving the token was re-minted.
        expect(current([reading({ account: `b` }), reading()])).toBe(false);
        // Read since, but the store has given up on the credential: a reconnect is the only thing that fixes it.
        expect(current([reading({ needsReauth: true })])).toBe(true);
        // Nothing read at all yet (mid-load): absence is not evidence, so the refusal keeps standing.
        expect(current([])).toBe(true);
    });

    // An `entitlement` refusal can't be answered by any reading: a blocked seat's token still authenticates and
    // its pools still publish normally. Only the daemon's own turn-succeeded clear settles it.
    it(`keeps a revoked seat standing under a reading that would answer any other refusal`, () => {
        const refusal = { at: 1_000, kind: `entitlement` as const, message: `organization has disabled`, account: `a` };
        const current = (readings: RefusalReading[]): boolean | undefined => refusalNote(refusal, readings, 5_000)?.current;
        // Would answer an `auth` or `limit` refusal; says nothing about whether the seat may run at all.
        expect(current([reading({ measuredAt: 2_000, percent: 3, needsReauth: false })])).toBe(true);
        // Not even a reading taken long after it, which is the state a five-minute sweep guarantees.
        expect(current([reading({ measuredAt: 4_999 })])).toBe(true);
        const message = `organization has disabled`;
        const standing = refusalNote({ at: 1_000, kind: `entitlement` as const, message, account: `a` }, [reading()], 5_000);
        expect(standing?.line).toContain(message);
        expect(standing?.line).toContain(formatAge(1_000, 5_000));
        expect(standing?.current).toBe(true);
    });

    it(`settles a refusal whose account has been disconnected, instead of shouting about one nobody holds`, () => {
        const message = `401 OAuth access token has been revoked.`;
        const refusal = { at: 1_000, kind: `auth` as const, message, account: `a` };
        const note = refusalNote(refusal, [reading({ account: `b`, measuredAt: 500 })], 5_000);
        expect(note?.current).toBe(false);
        expect(note?.line).toContain(formatAge(1_000, 5_000));
        expect(note?.line).not.toContain(message);
    });

    // Condition comes from the refusal's own `kind`, not the frame code, so a spent Kimi plan doesn't read as a
    // broken sign-in. Quoted verbatim while current; the words move to `detail` once answered.
    it(`quotes the provider while the refusal stands, and says what answered it once one has`, () => {
        const message = `API Error: 403 You've reached your usage limit for this billing cycle.`;
        const standingLimit = refusalNote({ at: 0, kind: `limit`, message }, [], 300_000);
        expect(standingLimit?.line).toContain(message);
        expect(standingLimit?.line).toContain(formatAge(0, 300_000));
        expect(standingLimit?.current).toBe(true);

        const tokenMessage = `token revoked`;
        const standingAuth = refusalNote({ at: 0, kind: `auth`, message: tokenMessage }, [], 300_000);
        expect(standingAuth?.line).toContain(tokenMessage);
        expect(standingAuth?.current).toBe(true);
        expect(standingAuth?.line).not.toEqual(standingLimit?.line);

        const answered = refusalNote({ at: 0, kind: `auth`, message: tokenMessage }, [reading({ measuredAt: 1_000 })], 300_000);
        expect(answered?.current).toBe(false);
        expect(answered?.line).not.toContain(tokenMessage);
        expect(answered?.line).not.toEqual(standingAuth?.line);
        expect(answered?.detail).toBe(tokenMessage);

        const answeredLimit = refusalNote({ at: 0, kind: `limit`, message }, [reading({ measuredAt: 1_000 })], 300_000);
        expect(answeredLimit?.current).toBe(false);
        expect(answeredLimit?.line).not.toContain(message);
        expect(answeredLimit?.line).not.toEqual(standingLimit?.line);
    });

    // A spent pool isn't raised as an alarm: it refills on schedule and the translator already routes around it.
    // Only a credential that can't be refreshed is.
    it(`raises only a credential that cannot be refreshed, never a pool that will reopen on its own`, () => {
        const summary = planLimitSummary([
            at(95, { id: `spent` }),
            at(10, { id: `fine` }),
            at(undefined, { id: `broken`, needsReauth: true }),
            at(undefined, { id: `unread` }),
        ]);
        expect(summary.attention.map((row) => row.id)).toEqual([`broken`]);
        // Every account is still banded, so what the alarm dropped the capacity strip keeps.
        expect(summary.counts).toEqual({ spent: 1, tight: 0, room: 1, unread: 2, none: 0 });
        expect(summary.accounts).toBe(4);
    });

    // Even a spent account whose credential is dead belongs here: on the reauth, not on the spend.
    it(`raises a dead credential whatever its pools say`, () => {
        const summary = planLimitSummary([at(99, { id: `both`, needsReauth: true }), at(99, { id: `justSpent` })]);
        expect(summary.attention.map((row) => row.id)).toEqual([`both`]);
    });
});
