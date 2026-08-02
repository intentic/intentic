import type { AccountUsage, OauthAccount, TranslatorAccounts, UsageWindow } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import { providerAccounts, translatorAccounts } from "./providerAccounts";
import {
    bindingWindow,
    formatAge,
    formatReset,
    formatUtilization,
    formatWait,
    isSpent,
    isStale,
    liveUsage,
    orderedWindows,
    planLimitBand,
    planLimitGroups,
    type PlanLimitRow,
    planLimitRows,
    planLimitSummary,
    refusalIsCurrent,
    refusalLine,
    usageDetail,
    usagePercent,
    usageRing,
    usageStatusByAccount,
    usageStatusFor,
    usageWindowLabel,
} from "./usageStatus";

const window = (over: Partial<UsageWindow> = {}): UsageWindow => ({ kind: `seven_day`, utilization: 42.4, ...over });
const usage = (over: Partial<AccountUsage> = {}): AccountUsage => ({ windows: [window()], measuredAt: 0, ...over });

describe(`usageWindowLabel`, () => {
    it(`keeps every weekly pool distinguishable — folding them is the bug it exists to prevent`, () => {
        expect(usageWindowLabel(window({ kind: `five_hour` }))).toBe(`5-hour session`);
        expect(usageWindowLabel(window({ kind: `seven_day` }))).toBe(`Weekly · all models`);
        expect(usageWindowLabel(window({ kind: `seven_day_opus` }))).toBe(`Weekly · Opus`);
        expect(usageWindowLabel(window({ kind: `seven_day_oauth_apps` }))).toBe(`Weekly · third-party apps`);
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
    it(`is the FULLEST pool — the account is as constrained as its tightest allowance`, () => {
        const picked = bindingWindow(
            usage({ windows: [window({ kind: `five_hour`, utilization: 12 }), window({ kind: `seven_day`, utilization: 98 })] }),
        );
        expect(picked?.kind).toBe(`seven_day`);
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
});

describe(`isStale / formatUtilization`, () => {
    const now = 1_000_000_000_000;
    it(`turns an overtaken reading into a floor rather than a figure`, () => {
        expect(isStale(usage({ measuredAt: now - 60_000 }), now)).toBe(false);
        expect(isStale(usage({ measuredAt: now - 8 * 3_600_000 }), now)).toBe(true);
        expect(formatUtilization(98, false)).toBe(`98%`);
        expect(formatUtilization(98, true)).toBe(`≥98%`);
    });
});

describe(`usageDetail`, () => {
    it(`lists EVERY pool, because which one is binding is what a single number can't say`, () => {
        const detail = usageDetail(
            usage({
                windows: [window({ kind: `five_hour`, utilization: 12 }), window({ kind: `seven_day`, utilization: 98 })],
                measuredAt: Date.now(),
            }),
        );
        expect(detail).toBe(`5-hour session 12% · Weekly · all models 98% · measured just now`);
    });

    it(`names each pool's reset beside its figure — "wait 20 minutes" and "wait until Thursday" are different answers`, () => {
        const resetsAt = 1_700_000_000;
        const detail = usageDetail(
            usage({
                windows: [window({ kind: `five_hour`, utilization: 91, resetsAt }), window({ kind: `seven_day`, utilization: 40 })],
                measuredAt: Date.now(),
            }),
        );
        // formatReset renders in the runner's locale/zone, so the expectation reuses it and asserts placement.
        expect(detail).toBe(`5-hour session 91% (resets ${formatReset(resetsAt)}) · Weekly · all models 40% · measured just now`);
    });

    it(`marks every figure as a floor once the reading is old enough to have been overtaken elsewhere`, () => {
        const detail = usageDetail(usage({ windows: [window({ kind: `seven_day`, utilization: 1 })], measuredAt: Date.now() - 8 * 3_600_000 }));
        expect(detail).toBe(`Weekly · all models ≥1% · measured 8h ago`);
    });
});

/* The outage retry's wait, which is the one instant in the app a wall-clock time would misreport: it is seconds
 * to minutes out, not hours, and it grows with every attempt. Coarse on purpose — the daemon's schedule carries
 * jitter and polls on its own cadence, so second-accurate wording here would promise precision it cannot keep. */
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

    it(`never counts backwards past zero — a due-but-unfired retry reads as imminent, not overdue`, () => {
        expect(formatWait(now / 1000 - 60, now)).toBe(`about 5s`);
    });
});

/* The account row's ring. Every provider reaches this the same way — the daemon attaches the same AccountUsage
 * to a native account and to a routed subscription alike — so what is pinned here is the meaning of the ring
 * itself, which the Agent tab, the picker and the composer all have to agree on. */
describe(`usageRing`, () => {
    it(`renders no ring at all for an account nobody has measured`, () => {
        // The state the row answers with a plain dot. It must stay distinguishable from a measured 0%, which is
        // what a green "0%" ring over an unread account would destroy.
        expect(usageRing(undefined)).toBeUndefined();
    });

    it(`reads a spent account as a full red ring rather than a healthy dot`, () => {
        // The exact shape a used-up Google or ChatGPT subscription arrives in — the bug this feature exists for.
        const ring = usageRing(usage({ windows: [window({ kind: `google:weekly`, utilization: 100 })] }));
        expect(ring?.percent).toBe(100);
        expect(ring?.tone).toBe(`text-danger`);
    });

    it(`treats a fully reset account as 0%, not as unknown`, () => {
        // usagePercent alone answers undefined here (no live windows). On an account row that is the wrong
        // answer: the account was measured and every pool reopened, so it has room rather than no reading.
        const ring = usageRing(usage({ windows: [] }));
        expect(ring?.percent).toBe(0);
        expect(ring?.tone).toBe(`text-link`);
    });

    it(`shows the pool that bites first, not whichever the provider listed first`, () => {
        const ring = usageRing(usage({ windows: [window({ kind: `five_hour`, utilization: 12 }), window({ kind: `seven_day`, utilization: 91 })] }));
        expect(ring?.percent).toBe(91);
        expect(ring?.tooltip).toContain(`5-hour session`);
        expect(ring?.tooltip).toContain(`Weekly · all models`);
    });
});

// One definition of "spent", because three surfaces act on it: the ring turns red, the row dims, and the list
// sinks the account below the ones with headroom. They disagreed while each carried its own threshold.
describe(`isSpent`, () => {
    it(`is false for an account with no reading — unknown is not exhausted`, () => {
        expect(isSpent(undefined)).toBe(false);
    });

    it(`agrees with the ring's own danger tone at the boundary`, () => {
        const at = usage({ windows: [window({ utilization: 90 })] });
        const below = usage({ windows: [window({ utilization: 89 })] });
        expect([isSpent(at), usageRing(at)?.tone]).toEqual([true, `text-danger`]);
        expect([isSpent(below), usageRing(below)?.tone]).toEqual([false, `text-warning`]);
    });
});

/* Which of the two readings an account row draws. The daemon's rides the accounts list for every provider; the
 * streamed one is pushed by a turn ending in this tab and only ever exists for Claude. Newer measurement wins,
 * so a routed subscription simply keeps the daemon's. */
describe(`liveUsage`, () => {
    it(`keeps the daemon's reading when nothing has streamed for that account`, () => {
        const attached = usage({ measuredAt: 500 });
        expect(liveUsage(`gemini-account`, attached)).toBe(attached);
    });

    it(`prefers a turn's fresher frame over the list it was fetched alongside`, () => {
        const streamed = usage({ measuredAt: 900 });
        usageStatusByAccount.value = { "claude-1": streamed };
        // toEqual, not toBe: the shared store is a Vue ref, so what comes back is its reactive proxy.
        expect(liveUsage(`claude-1`, usage({ measuredAt: 500 }))).toEqual(streamed);
        usageStatusByAccount.value = {};
    });

    it(`does not let a stale frame overwrite a newer reading from the daemon`, () => {
        const attached = usage({ measuredAt: 900 });
        usageStatusByAccount.value = { "claude-1": usage({ measuredAt: 500 }) };
        expect(liveUsage(`claude-1`, attached)).toBe(attached);
        usageStatusByAccount.value = {};
    });

    it(`falls back to a streamed frame for an account the list carried no reading for`, () => {
        const streamed = usage({ measuredAt: 100 });
        usageStatusByAccount.value = { "claude-1": streamed };
        expect(liveUsage(`claude-1`, undefined)).toEqual(streamed);
        usageStatusByAccount.value = {};
    });
});

/* The same merge for the surfaces that hold only an id — the composer chip, the picker's account rows, the
 * sentence a refused turn prints. They used to read the streamed map alone, which is why a chat left open
 * reported an hours-old floor while the account rows on the next route showed the current number. */
describe(`usageStatusFor`, () => {
    it(`finds the daemon's reading on whichever list the account is on`, () => {
        providerAccounts.value = { ...providerAccounts.value, claude: [{ id: `claude-1`, label: `Claude`, connectedAt: 0, usage: usage() }] };
        translatorAccounts.value = { ...translatorAccounts.value, gemini: [{ name: `g-1`, label: `Google`, usage: usage({ measuredAt: 7 }) }] };

        expect(usageStatusFor(`claude-1`)?.measuredAt).toBe(0);
        // A routed subscription is keyed by its auth-file name, the key its row is drawn under.
        expect(usageStatusFor(`g-1`)?.measuredAt).toBe(7);
        expect(usageStatusFor(`nobody`)).toBeUndefined();
        expect(usageStatusFor(undefined)).toBeUndefined();
    });

    it(`still prefers a turn's own frame once it is the newer of the two`, () => {
        providerAccounts.value = { ...providerAccounts.value, claude: [{ id: `claude-1`, label: `Claude`, connectedAt: 0, usage: usage() }] };
        usageStatusByAccount.value = { "claude-1": usage({ measuredAt: 900 }) };
        expect(usageStatusFor(`claude-1`)?.measuredAt).toBe(900);
        usageStatusByAccount.value = {};
    });
});

/* The Usage tab's meters. What is being guarded here is coverage: this projection read only the NATIVE account
 * lists, and only through the streamed map, so a Google subscription whose quota the daemon had pulled and
 * handed over on its account row could not appear on that screen at all. */
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
        // Kimi is deliberately NOT the example any more: its `/coding/v1/usages` reading is pulled like
        // ChatGPT's and Google's, so `readable` is true for it and unread means unread. SuperGrok is the one
        // plan left that publishes nothing at all, which is the state this pair of columns exists to separate.
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

    it(`sinks an unmeasured account below every measured one — unknown is not headroom`, () => {
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

    it(`prefers a turn's streamed frame over the account row it arrived with`, () => {
        usageStatusByAccount.value = { "claude-1": usage({ windows: [window({ utilization: 96 })], measuredAt: 900 }) };
        const rows = planLimitRows({ claude: [account({ usage: usage({ measuredAt: 500 }) })] }, noRouted);
        expect(rows[0]?.percent).toBe(96);
        usageStatusByAccount.value = {};
    });
});

/* The aggregate the panel is built on. A row list stops answering anything at 36 accounts — these are the three
 * questions that replace it: how much of the fleet can serve a turn, where, and what is broken. */
describe(`plan-limit aggregates`, () => {
    const at = (percent: number | undefined, over: Partial<PlanLimitRow> = {}): PlanLimitRow => ({
        id: `claude:${percent ?? `none`}`,
        provider: `claude`,
        label: `account`,
        percent,
        pools: percent === undefined ? [] : [{ kind: `seven_day`, label: `Weekly`, percent, resetsAt: 5_000 }],
        binding: percent === undefined ? undefined : { kind: `seven_day`, label: `Weekly`, percent, resetsAt: 5_000 },
        measuredAt: percent === undefined ? undefined : 0,
        stale: false,
        readable: true,
        needsReauth: false,
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
        const past = at(30, { id: `past`, pools: [{ kind: `five_hour`, label: `5-hour`, percent: 30, resetsAt: 1_000 }] });
        const future = at(40, { id: `future`, pools: [{ kind: `seven_day`, label: `Weekly`, percent: 40, resetsAt: 9_000 }] });
        // now = 5s in epoch ms ⇒ the 1,000s reset is behind us and the 9,000s one is not.
        expect(planLimitSummary([past, future], 5_000_000).nextResetAt).toBe(9_000);
        expect(planLimitSummary([past], 5_000_000).nextResetAt).toBeUndefined();
    });

    /* The refusal, which is the only OBSERVED fact on this screen — everything else is a poll. What these guard
     * is that it is read as such: it survives a week in the store, so the question "is this still describing the
     * situation" has to be answered here rather than by whether a record exists. */
    it(`hands each provider its own last refusal`, () => {
        const refusals = { kimi: { at: 1_000, kind: `limit` as const, message: `You've reached your usage limit` } };
        const groups = planLimitGroups([at(20, { id: `k`, provider: `kimi` }), at(95, { id: `c` })], refusals);
        expect(groups.map((group) => [group.provider, group.refusal?.message])).toEqual([
            [`claude`, undefined],
            [`kimi`, `You've reached your usage limit`],
        ]);
    });

    it(`stays current until a reading taken since finds headroom`, () => {
        const refusal = { at: 1_000, kind: `limit` as const, message: `spent` };
        // Nothing measured at all, and a reading from BEFORE the refusal: neither can contradict it.
        expect(refusalIsCurrent(refusal, [])).toBe(true);
        expect(refusalIsCurrent(refusal, [{ measuredAt: 500, percent: 3 }])).toBe(true);
        // Measured since, and still spent — the refusal is exactly what that pool is saying.
        expect(refusalIsCurrent(refusal, [{ measuredAt: 2_000, percent: 99 }])).toBe(true);
        // Measured since, with room: the pool reopened and the refusal is history.
        expect(refusalIsCurrent(refusal, [{ measuredAt: 2_000, percent: 3 }])).toBe(false);
        expect(refusalIsCurrent(undefined, [])).toBe(false);
    });

    /* The prefix is read off the record's `kind`, which the daemon derived from the SENTENCE rather than from
     * the frame code — this is the whole reason a spent Kimi plan stops telling the user to reconnect a healthy
     * account. The provider's own words are then printed verbatim: they are the only part naming which pool. */
    it(`names the condition from the record, then quotes the provider verbatim`, () => {
        const message = `API Error: 403 You've reached your usage limit for this billing cycle.`;
        expect(refusalLine({ at: 0, kind: `limit`, message }, 300_000)).toBe(`Hit its usage limit 5m ago — ${message}`);
        expect(refusalLine({ at: 0, kind: `auth`, message: `token revoked` }, 300_000)).toBe(`Refused its credential 5m ago — token revoked`);
    });

    it(`raises only what someone has to act on — a spent pool or a dead credential`, () => {
        const summary = planLimitSummary([
            at(95, { id: `spent` }),
            at(10, { id: `fine` }),
            at(undefined, { id: `broken`, needsReauth: true }),
            at(undefined, { id: `unread` }),
        ]);
        expect(summary.attention.map((row) => row.id)).toEqual([`spent`, `broken`]);
        expect(summary.counts).toEqual({ spent: 1, tight: 0, room: 1, unread: 2, none: 0 });
        expect(summary.accounts).toBe(4);
    });
});
