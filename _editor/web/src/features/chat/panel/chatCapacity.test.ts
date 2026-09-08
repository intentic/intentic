import type { AccountUsage, OauthAccount, TranslatorAccount, TranslatorAccounts } from "@intentic/sandbox-contract";
import { afterEach, describe, expect, it } from "vitest";
import { CAPACITY_RAIL_PX, chatCapacity, hasCapacity, railFitsBeside } from "./chatCapacity";
import { providerAccounts, providerRefusals, translatorAccounts, usageByAccount } from "../accounts/providerAccounts";

// The rail's offers must all still serve a turn, and everything it withholds must be accounted for: spent, refused,
// dropped, or pooled.

const NOW = 1_700_000_000_000;
const NO_ROUTED: TranslatorAccounts = { codex: [], grok: [], kimi: [], gemini: [] };

// Always a fresh reading; staleness is usageStatus's concern, not this helper's.
const usage = (percent: number, resetsAt = 1_700_003_600): AccountUsage => ({
    measuredAt: NOW - 60_000,
    windows: [{ kind: `seven_day`, utilization: percent, resetsAt, gates: `all` }],
});

const claude = (over: Partial<OauthAccount>): OauthAccount => ({ id: `acc`, label: `first@example.com`, connectedAt: 0, ...over });

const google = (index: number, percent: number): TranslatorAccount => ({
    name: `gemini-${index}`,
    label: `radarsuspam${index}@gmail.com`,
    usage: usage(percent),
});

afterEach(() => {
    providerAccounts.value = {};
    translatorAccounts.value = NO_ROUTED;
    providerRefusals.value = {};
    usageByAccount.value = {};
});

describe(`what the rail offers`, () => {
    it(`lists the accounts with room, roomiest first, and holds back the ones that are spent`, () => {
        providerAccounts.value = {
            claude: [
                claude({ id: `a`, label: `busy@example.com`, usage: usage(62) }),
                claude({ id: `b`, label: `spent@example.com`, usage: usage(100) }),
                claude({ id: `c`, label: `fresh@example.com`, usage: usage(8) }),
            ],
        };
        translatorAccounts.value = NO_ROUTED;

        const [entry] = chatCapacity(NOW).providers;
        expect(entry?.rows.map((row) => row.label)).toEqual([`fresh@example.com`, `busy@example.com`]);
        expect([entry?.ready, entry?.total]).toEqual([2, 3]);
        expect(chatCapacity(NOW).out).toEqual([]);
    });

    it(`keeps offering an account until its pool is exhausted, not from the moment it turns red`, () => {
        providerAccounts.value = { claude: [claude({ id: `a`, label: `edge`, usage: usage(99) })] };
        expect(chatCapacity(NOW).providers[0]?.rows[0]?.percent).toBe(99);

        providerAccounts.value = { claude: [claude({ id: `a`, label: `edge`, usage: usage(100) })] };
        expect(chatCapacity(NOW).providers).toEqual([]);
    });

    it(`keeps an account whose per-model slice is spent, and ranks it by what still gates every turn`, () => {
        providerAccounts.value = {
            claude: [
                claude({
                    id: `a`,
                    label: `metered@example.com`,
                    usage: {
                        measuredAt: NOW - 60_000,
                        windows: [
                            { kind: `five_hour`, utilization: 58, resetsAt: 1_700_003_600, gates: `all` },
                            { kind: `seven_day`, utilization: 73, resetsAt: 1_700_400_000, gates: `all` },
                            { kind: `model:Fable`, label: `Fable`, utilization: 100, resetsAt: 1_700_400_000, gates: { models: [`Fable`] } },
                        ],
                    },
                }),
            ],
        };

        const [entry] = chatCapacity(NOW).providers;
        expect(entry?.rows[0]?.percent).toBe(73);
        expect(entry?.rows[0]?.lanes.map((lane) => [lane.short, lane.scope, lane.percent])).toEqual([
            [`5h`, undefined, 58],
            [`wk`, `Fable`, 100],
            [`wk`, undefined, 73],
        ]);
        expect(chatCapacity(NOW).out).toEqual([]);
    });

    it(`drops an account whose all-models pool is exhausted, however much room its slices have`, () => {
        providerAccounts.value = {
            claude: [
                claude({
                    id: `a`,
                    label: `throttled@example.com`,
                    usage: {
                        measuredAt: NOW - 60_000,
                        windows: [
                            { kind: `five_hour`, utilization: 100, resetsAt: 1_700_003_600, gates: `all` },
                            { kind: `model:Fable`, label: `Fable`, utilization: 4, resetsAt: 1_700_400_000, gates: { models: [`Fable`] } },
                        ],
                    },
                }),
            ],
        };

        const capacity = chatCapacity(NOW);
        expect(capacity.providers).toEqual([]);
        expect(capacity.out[0]).toMatchObject({ reason: `spent`, reopensAt: 1_700_003_600 });
    });

    it(`reads a plan with no all-models pool by its roomiest family`, () => {
        const families = (gemini: number, thirdParty: number): AccountUsage => ({
            measuredAt: NOW - 60_000,
            windows: [
                { kind: `google:gemini-weekly`, label: `Gemini Models · Weekly`, utilization: gemini, resetsAt: 1_700_400_000, gates: { models: [`gemini`] } },
                {
                    kind: `google:3p-weekly`,
                    label: `Claude and GPT Models · Weekly`,
                    utilization: thirdParty,
                    resetsAt: 1_700_400_000,
                    gates: { models: [`claude`, `gpt`] },
                },
            ],
        });

        translatorAccounts.value = { ...NO_ROUTED, gemini: [{ name: `gemini-1`, label: `one@gmail.com`, usage: families(100, 21) }] };
        expect(chatCapacity(NOW).providers[0]?.rows[0]?.percent).toBe(21);

        translatorAccounts.value = { ...NO_ROUTED, gemini: [{ name: `gemini-1`, label: `one@gmail.com`, usage: families(100, 100) }] };
        expect(chatCapacity(NOW).providers).toEqual([]);
    });

    it(`offers an account with no reading, and says which kind of nothing it has`, () => {
        providerAccounts.value = { claude: [claude({ id: `a`, label: `unread` })] };
        const [entry] = chatCapacity(NOW).providers;
        expect(entry?.rows[0]).toMatchObject({ percent: undefined, note: `no reading yet` });
    });
});

describe(`what cannot serve a turn, whatever its pools say`, () => {
    it(`holds back the account a standing refusal names, however much room it reports`, () => {
        providerAccounts.value = {
            claude: [claude({ id: `a`, label: `turned-away`, usage: usage(5) }), claude({ id: `b`, label: `fine`, usage: usage(40) })],
        };
        providerRefusals.value = {
            claude: { at: NOW - 60_000, kind: `entitlement`, message: `Claude Code is not enabled for this account.`, account: `a` },
        };

        const [entry] = chatCapacity(NOW).providers;
        expect(entry?.rows.map((row) => row.label)).toEqual([`fine`]);
    });

    // A routed refusal without an account name drops the whole pool. Entitlement is used here since a spent-quota
    // refusal already reads that pool as full elsewhere.
    it(`takes a whole routed pool off the list when its refusal names no account`, () => {
        translatorAccounts.value = { ...NO_ROUTED, gemini: [google(1, 4), google(2, 11)] };
        providerRefusals.value = {
            gemini: { at: NOW - 60_000, kind: `entitlement`, message: `Gemini for Google Cloud has not been enabled for this project.` },
        };

        const capacity = chatCapacity(NOW);
        expect(capacity.providers).toEqual([]);
        expect(capacity.out.map((entry) => entry.reason)).toEqual([`refused your last turn`]);
    });

    // Reads as spent rather than as a refusal; the pin is shared with usageStatus so this cannot disagree with the
    // composer.
    it(`dates the return of a routed pool whose refusal was a spent quota`, () => {
        translatorAccounts.value = { ...NO_ROUTED, gemini: [google(1, 4)] };
        providerRefusals.value = { gemini: { at: NOW - 60_000, kind: `limit`, message: `Quota exceeded for this project.` } };

        const capacity = chatCapacity(NOW);
        expect(capacity.providers).toEqual([]);
        expect(capacity.out[0]).toMatchObject({ reason: `spent`, reopensAt: 1_700_003_600 });
    });

    // The refusal pins to spent only the pool whose model matches; other pools on the account are unaffected.
    it(`keeps an account whose standing limit refusal pinned a per-model slice`, () => {
        providerAccounts.value = {
            claude: [
                claude({
                    id: `a`,
                    label: `metered@example.com`,
                    usage: {
                        measuredAt: NOW - 60_000,
                        windows: [
                            { kind: `five_hour`, utilization: 20, resetsAt: 1_700_003_600, gates: `all` },
                            { kind: `seven_day`, utilization: 40, resetsAt: 1_700_400_000, gates: `all` },
                            { kind: `model:Fable`, label: `Fable`, utilization: 82, resetsAt: 1_700_400_000, gates: { models: [`Fable`] } },
                        ],
                    },
                }),
            ],
        };
        providerRefusals.value = {
            claude: {
                at: NOW - 30_000,
                kind: `limit`,
                message: `You've reached your weekly limit for Claude Fable.`,
                account: `a`,
                model: `claude-fable-1`,
            },
        };

        const [entry] = chatCapacity(NOW).providers;
        expect(entry?.rows[0]).toMatchObject({ percent: 40 });
        expect(entry?.rows[0]?.lanes.map((lane) => [lane.scope, lane.percent])).toEqual([
            [undefined, 20],
            [`Fable`, 100],
            [undefined, 40],
        ]);
    });

    it(`drops an account whose standing limit refusal pinned a pool that gates every model`, () => {
        providerAccounts.value = {
            claude: [
                claude({
                    id: `a`,
                    label: `throttled@example.com`,
                    usage: {
                        measuredAt: NOW - 60_000,
                        windows: [
                            { kind: `five_hour`, utilization: 88, resetsAt: 1_700_003_600, gates: `all` },
                            { kind: `seven_day`, utilization: 40, resetsAt: 1_700_400_000, gates: `all` },
                        ],
                    },
                }),
            ],
        };
        providerRefusals.value = {
            claude: { at: NOW - 30_000, kind: `limit`, message: `You've reached your 5-hour limit.`, account: `a`, model: `claude-haiku-4-5` },
        };

        const capacity = chatCapacity(NOW);
        expect(capacity.providers).toEqual([]);
        expect(capacity.out[0]).toMatchObject({ reason: `spent`, reopensAt: 1_700_003_600 });
    });

    it(`holds back a credential that can no longer be refreshed, and counts it where the fix is`, () => {
        providerAccounts.value = { claude: [claude({ id: `a`, label: `expired`, usage: usage(3), needsReauth: true })] };
        const capacity = chatCapacity(NOW);
        expect(capacity.providers).toEqual([]);
        expect([capacity.needsReauth, capacity.out[0]?.reason]).toEqual([1, `sign-in expired`]);
    });
});

describe(`what the rail says about what it is not offering`, () => {
    // An absent provider could mean spent-until-later or never-connected; the footnote is what tells those apart.
    it(`names a spent provider and the instant it comes back`, () => {
        providerAccounts.value = { claude: [claude({ id: `a`, label: `spent`, usage: usage(100, 1_700_090_000) })] };
        expect(chatCapacity(NOW).out).toEqual([
            { provider: `claude`, label: `Claude Code`, reason: `spent`, reopensAt: 1_700_090_000, detail: undefined },
        ]);
    });

    it(`dates the return from the pool that is actually spent, not the soonest one on the account`, () => {
        providerAccounts.value = {
            claude: [
                claude({
                    id: `a`,
                    label: `spent`,
                    usage: {
                        measuredAt: NOW - 60_000,
                        windows: [
                            { kind: `five_hour`, utilization: 20, resetsAt: 1_700_003_600, gates: `all` },
                            { kind: `seven_day`, utilization: 100, resetsAt: 1_700_400_000, gates: `all` },
                        ],
                    },
                }),
            ],
        };
        expect(chatCapacity(NOW).out[0]?.reopensAt).toBe(1_700_400_000);
    });

    it(`offers no reopen instant when every spent pool's reset has already passed`, () => {
        providerAccounts.value = { claude: [claude({ id: `a`, label: `spent`, usage: usage(100, Math.floor(NOW / 1000) - 60) })] };
        expect(chatCapacity(NOW).out[0]).toMatchObject({ reason: `spent`, reopensAt: undefined });
    });
});

describe(`a pool nobody picks among`, () => {
    // Many routed sign-ins are one offer to a reader who cannot act on any of them individually.
    it(`stands a routed provider's whole pool in for by its roomiest reading`, () => {
        translatorAccounts.value = {
            ...NO_ROUTED,
            gemini: [google(1, 44), google(2, 4), google(3, 100), google(4, 30), google(5, 12)],
        };

        const [entry] = chatCapacity(NOW).providers;
        expect(entry?.pooled).toBe(true);
        expect(entry?.rows).toHaveLength(1);
        expect(entry?.rows[0]).toMatchObject({ label: undefined, percent: 4 });
        expect([entry?.ready, entry?.total, entry?.hidden]).toEqual([4, 5, 0]);
    });

    it(`caps a choosable list at three rows and counts the rest`, () => {
        providerAccounts.value = {
            claude: [1, 2, 3, 4, 5].map((index) => claude({ id: `a${index}`, label: `a${index}@example.com`, usage: usage(index * 5) })),
        };
        const [entry] = chatCapacity(NOW).providers;
        expect(entry?.rows.map((row) => row.label)).toEqual([`a1@example.com`, `a2@example.com`, `a3@example.com`]);
        expect(entry?.hidden).toBe(2);
    });

    it(`leaves a lone account's row unnamed and lets its lanes carry the pools`, () => {
        providerAccounts.value = { claude: [claude({ id: `a`, label: `only@example.com`, usage: usage(30) })] };
        const [row] = chatCapacity(NOW).providers[0]?.rows ?? [];
        expect(row).toMatchObject({ label: undefined });
        expect(row?.lanes.map((lane) => [lane.short, lane.percent])).toEqual([[`wk`, 30]]);
    });
});

// A subscription's 5-hour session and week run out and reset separately, so one percentage cannot represent both.
describe(`the allowances behind one account`, () => {
    const pools = (
        ...windows: { kind: string; label?: string; utilization: number; gates?: `all` | `none` | { models: string[] } }[]
    ): AccountUsage => ({
        measuredAt: NOW - 60_000,
        windows: windows.map((window) => ({ resetsAt: 1_700_003_600, gates: `all` as const, ...window })),
    });

    it(`draws a lane per allowance, shortest window first, and names each by its length`, () => {
        providerAccounts.value = {
            claude: [claude({ id: `a`, usage: pools({ kind: `seven_day`, utilization: 87 }, { kind: `five_hour`, utilization: 12 }) })],
        };

        const [row] = chatCapacity(NOW).providers[0]?.rows ?? [];
        expect(row?.percent).toBe(87);
        expect(row?.lanes.map((lane) => [lane.short, lane.percent])).toEqual([
            [`5h`, 12],
            [`wk`, 87],
        ]);
    });

    it(`says what a scoped pool is scoped to, and leaves an all-models pool to its period alone`, () => {
        providerAccounts.value = {
            claude: [
                claude({
                    id: `a`,
                    usage: pools(
                        { kind: `seven_day`, utilization: 12 },
                        { kind: `seven_day_opus`, utilization: 84, gates: { models: [`opus`] } },
                        { kind: `model:Fable`, label: `Fable`, utilization: 30, gates: { models: [`Fable`] } },
                    ),
                }),
            ],
        };

        const [row] = chatCapacity(NOW).providers[0]?.rows ?? [];
        expect(row?.lanes.map((lane) => [lane.short, lane.scope])).toEqual([
            [`wk`, `Opus`],
            [`wk`, `Fable`],
            [`wk`, undefined],
        ]);
    });

    it(`draws no lane for a pool that cannot gate a turn`, () => {
        providerAccounts.value = {
            claude: [
                claude({
                    id: `a`,
                    usage: pools({ kind: `five_hour`, utilization: 20 }, { kind: `surface:Cowork`, label: `Cowork`, utilization: 99, gates: `none` }),
                }),
            ],
        };

        const [row] = chatCapacity(NOW).providers[0]?.rows ?? [];
        expect(row?.lanes.map((lane) => lane.label)).toEqual([`5-hour session`]);
    });

    // An unrecognised period sorts last; a window named only in words still sorts by the length it states.
    it(`reads a window the provider spells out in words`, () => {
        translatorAccounts.value = {
            ...NO_ROUTED,
            kimi: [
                {
                    name: `kimi-1`,
                    label: `kimi`,
                    usage: pools(
                        { kind: `seven_day`, utilization: 40 },
                        { kind: `kimi:43200s`, label: `12-hour window`, utilization: 55 },
                        { kind: `five_hour`, utilization: 5 },
                    ),
                },
            ],
        };

        const [row] = chatCapacity(NOW).providers[0]?.rows ?? [];
        expect(row?.lanes.map((lane) => lane.short)).toEqual([`5h`, `12h`, `wk`]);
    });
});

describe(`the order the providers are read in`, () => {
    it(`puts the roomiest provider first, and a provider with no reading behind every provider that has one`, () => {
        providerAccounts.value = { claude: [claude({ id: `a`, label: `claude`, usage: usage(70) })] };
        translatorAccounts.value = {
            ...NO_ROUTED,
            gemini: [google(1, 12)],
            // Grok publishes no usage data: unmeasurable, not the same as roomy.
            grok: [{ name: `grok-1`, label: `grok@example.com` }],
        };
        expect(chatCapacity(NOW).providers.map((entry) => entry.provider)).toEqual([`gemini`, `claude`, `grok`]);
    });
});

// The rail claims width only once every open pane already has its full reading measure; thresholds are asserted by
// value at the boundary.
describe(`when there is room for the rail`, () => {
    const LIST_RAIL = 320;
    // One pane's comfort width plus both rails: the narrowest panel with anything to spare.
    const FITS = 872 + LIST_RAIL + CAPACITY_RAIL_PX;

    it(`yields the column only once no pane pays for it`, () => {
        expect(railFitsBeside(FITS, LIST_RAIL, 1)).toBe(true);
        expect(railFitsBeside(FITS - 1, LIST_RAIL, 1)).toBe(false);
    });

    it(`measures against the chat list's current width, not its default`, () => {
        expect(railFitsBeside(FITS, LIST_RAIL + 1, 1)).toBe(false);
    });

    it(`asks for the comfort width once per pane`, () => {
        expect(railFitsBeside(FITS + 872, LIST_RAIL, 2)).toBe(true);
        expect(railFitsBeside(FITS + 871, LIST_RAIL, 2)).toBe(false);
    });

    it(`draws nothing before the panel has been measured`, () => {
        expect(railFitsBeside(0, LIST_RAIL, 1)).toBe(false);
    });

    // hasCapacity() gates the width reserved for the rail before layout runs, so it must count routed connections (e.g.
    // Gemini) too, not only OAuth accounts.
    it(`knows an empty fleet from one whose connections are all routed`, () => {
        expect(hasCapacity()).toBe(false);

        translatorAccounts.value = { ...NO_ROUTED, gemini: [google(1, 4)] };
        expect(hasCapacity()).toBe(true);

        translatorAccounts.value = NO_ROUTED;
        providerAccounts.value = { claude: [claude({ id: `a`, label: `one@example.com`, usage: usage(41) })] };
        expect(hasCapacity()).toBe(true);
    });
});
