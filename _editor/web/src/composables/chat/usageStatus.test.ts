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
    type PlanHeadroom,
    planHeadroom,
    refusalNote,
    type RefusalReading,
    usageDetail,
    usagePercent,
    usageStatusByAccount,
    usageStatusFor,
    usageWindowLabel,
} from "./usageStatus";

const window = (over: Partial<UsageWindow> = {}): UsageWindow => ({ kind: `seven_day`, utilization: 42.4, ...over });
const usage = (over: Partial<AccountUsage> = {}): AccountUsage => ({ windows: [window()], measuredAt: 0, ...over });
// The projection every surface draws from. Undefined is reserved for an account nobody has measured, which is
// its own case below — everywhere else the reading exists, so unwrapping it here keeps the assertions readable.
const headroom = (over: Partial<AccountUsage> = {}): PlanHeadroom => {
    const projected = planHeadroom(usage(over));
    if (projected === undefined) {
        throw new Error(`a measured account always projects`);
    }
    return projected;
};

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
    // Rounds DOWN at every tier: an age is a floor, and these readings are floors themselves.
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
});

/* The sentence a screen reader hears in place of the card. It is the ONLY string form of the breakdown left —
 * the sighted reader gets a list of meters (UsageRing.vue) — so what is pinned here is that the spoken version
 * still carries every fact the card draws. */
describe(`usageDetail`, () => {
    it(`lists EVERY pool, because which one is binding is what a single number can't say`, () => {
        const detail = usageDetail(
            headroom({
                windows: [window({ kind: `five_hour`, utilization: 12 }), window({ kind: `seven_day`, utilization: 98 })],
                measuredAt: Date.now(),
            }),
        );
        expect(detail).toBe(`5-hour session 12% · Weekly · all models 98% · measured just now`);
    });

    it(`names each pool's reset beside its figure — "wait 20 minutes" and "wait until Thursday" are different answers`, () => {
        const resetsAt = 1_700_000_000;
        const detail = usageDetail(
            headroom({
                windows: [window({ kind: `five_hour`, utilization: 91, resetsAt }), window({ kind: `seven_day`, utilization: 40 })],
                measuredAt: Date.now(),
            }),
        );
        // formatReset renders in the runner's locale/zone, so the expectation reuses it and asserts placement.
        expect(detail).toBe(`5-hour session 91% (resets ${formatReset(resetsAt)}) · Weekly · all models 40% · measured just now`);
    });

    it(`marks every figure as a floor once the reading is old enough to have been overtaken elsewhere`, () => {
        const detail = usageDetail(headroom({ windows: [window({ kind: `seven_day`, utilization: 1 })], measuredAt: Date.now() - 8 * 3_600_000 }));
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

/* The account row's ring, and the card behind it. Every provider reaches this the same way — the daemon
 * attaches the same AccountUsage to a native account and to a routed subscription alike — so what is pinned
 * here is the meaning of the projection itself, which the Agent tab, the picker and the composer all have to
 * agree on. */
describe(`planHeadroom`, () => {
    it(`renders no ring at all for an account nobody has measured`, () => {
        // The state the row answers with a plain dot. It must stay distinguishable from a measured 0%, which is
        // what a green "0%" ring over an unread account would destroy.
        expect(planHeadroom(undefined)).toBeUndefined();
    });

    it(`reads a spent account as a full red ring rather than a healthy dot`, () => {
        // The exact shape a used-up Google or ChatGPT subscription arrives in — the bug this feature exists for.
        const spent = headroom({ windows: [window({ kind: `google:weekly`, utilization: 100 })] });
        expect(spent.percent).toBe(100);
        expect(spent.tone).toBe(`text-danger`);
    });

    it(`treats a fully reset account as 0%, not as unknown`, () => {
        // usagePercent alone answers undefined here (no live windows). On an account row that is the wrong
        // answer: the account was measured and every pool reopened, so it has room rather than no reading.
        const reset = headroom({ windows: [] });
        expect(reset.percent).toBe(0);
        expect(reset.tone).toBe(`text-link`);
        // No pool to name, which is what the card says instead of listing nothing.
        expect(reset.binding).toBeUndefined();
    });

    it(`carries every pool, with the one that bites first named as the binding one`, () => {
        // The card draws all of them and the ring draws this one — from a single projection, so the arc and the
        // row it highlights can never come from different arithmetic.
        const mixed = headroom({
            windows: [window({ kind: `five_hour`, utilization: 12 }), window({ kind: `seven_day`, utilization: 91, resetsAt: 1_700_000_000 })],
        });
        expect(mixed.percent).toBe(91);
        expect(mixed.binding).toEqual({ kind: `seven_day`, label: `Weekly · all models`, percent: 91, resetsAt: 1_700_000_000 });
        expect(mixed.pools.map((pool) => pool.label)).toEqual([`5-hour session`, `Weekly · all models`]);
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
        expect([isSpent(at), planHeadroom(at)?.tone]).toEqual([true, `text-danger`]);
        expect([isSpent(below), planHeadroom(below)?.tone]).toEqual([false, `text-warning`]);
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
        account: `${percent ?? `none`}`,
        label: `account`,
        identity: undefined,
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
    it(`hands each provider its own last refusal, and points it at the account it names`, () => {
        const refusals = { kimi: { at: 1_000, kind: `limit` as const, message: `You've reached your usage limit`, account: `20` } };
        const groups = planLimitGroups([at(20, { id: `k`, provider: `kimi` }), at(95, { id: `c` })], refusals, 5_000);
        expect(groups.map((group) => [group.provider, group.refusal?.line])).toEqual([
            [`claude`, undefined],
            [`kimi`, `Hit its usage limit just now — You've reached your usage limit`],
        ]);
        // The row it belongs to, so the panel can draw it under that account rather than over the provider.
        expect(groups[1]?.refusedRow?.id).toBe(`k`);
    });

    /* A REFUSAL IS ANSWERED BY ITS OWN KIND OF EVIDENCE, FROM ITS OWN ACCOUNT. Headroom answers a spent pool and
     * says nothing about a rejected token; a working credential answers a 401 and says nothing about a pool. And
     * both questions are about the account the daemon named, never about whichever sibling happens to be idle —
     * that conflation is what left a healed 401 standing over three accounts it did not describe. */
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
        // Nothing measured at all, and a reading from BEFORE the refusal: neither can contradict it.
        expect(current([])).toBe(true);
        expect(current([reading({ measuredAt: 500 })])).toBe(true);
        // Measured since, and still spent — the refusal is exactly what that pool is saying.
        expect(current([reading({ percent: 99 })])).toBe(true);
        // Measured since, with room: the pool reopened and the refusal is history.
        expect(current([reading()])).toBe(false);
        expect(refusalNote(undefined, [], 5_000)).toBeUndefined();
    });

    it(`answers a rejected credential with the named account's own sign-in, not a sibling's percentage`, () => {
        const refusal = { at: 1_000, kind: `auth` as const, message: `401 OAuth access token has been revoked.`, account: `a` };
        const current = (readings: RefusalReading[]): boolean | undefined => refusalNote(refusal, readings, 5_000)?.current;
        // A DIFFERENT account of the same provider, read since and perfectly healthy, beside the named one whose
        // last reading predates the refusal. The sibling cannot speak for the credential that was rejected, and
        // letting it was what quietly dismissed a live 401.
        expect(current([reading({ account: `b` }), reading({ measuredAt: 500 })])).toBe(true);
        // The named account itself, read since — every reading is taken through that same credential, so it
        // worked. This is the state the daemon's own re-mint leaves behind seconds after a token is refused.
        expect(current([reading({ account: `b` }), reading()])).toBe(false);
        // Read since, but the store has given up on the credential: a reconnect is the only thing that fixes it.
        expect(current([reading({ needsReauth: true })])).toBe(true);
        // Nothing read at all yet (mid-load): absence is not evidence, so the refusal keeps standing.
        expect(current([])).toBe(true);
    });

    /* THE REFUSAL NO READING CAN ANSWER, and the reason it needed a kind of its own. An organization that has
     * turned Claude Code off for a seat leaves everything a reading can see untouched: the token authenticates,
     * so `needsReauth` stays false, and the plan's own endpoint keeps publishing pools, so a fresh measurement
     * lands within the minute with room to spare. Filed as `auth` that is precisely the shape of "authenticated
     * fine since" — so the very next quota sweep dismissed a live refusal and the account picker went back to
     * drawing a full green ring over the one account that could not run a single turn.
     *
     * The evidence that DOES settle it is a turn actually running, which only the daemon can witness (it drops
     * the record itself — see the refusal store's `clear`). Nothing this side may pre-empt that. */
    it(`keeps a revoked seat standing under a reading that would answer any other refusal`, () => {
        const refusal = { at: 1_000, kind: `entitlement` as const, message: `organization has disabled`, account: `a` };
        const current = (readings: RefusalReading[]): boolean | undefined => refusalNote(refusal, readings, 5_000)?.current;
        // Read since, healthy credential, pools wide open — an `auth` refusal would be answered by this, and a
        // `limit` one too. Neither says anything about whether the seat is allowed to run Claude Code.
        expect(current([reading({ measuredAt: 2_000, percent: 3, needsReauth: false })])).toBe(true);
        // Not even a reading taken long after it, which is the state a five-minute sweep guarantees.
        expect(current([reading({ measuredAt: 4_999 })])).toBe(true);
        // Its own sentence stays the headline for as long as it stands — it is the only part naming the fix.
        expect(refusalNote(refusal, [reading()], 5_000)?.line).toBe(`Turned this account away just now — organization has disabled`);
    });

    it(`settles a refusal whose account has been disconnected, instead of shouting about one nobody holds`, () => {
        const refusal = { at: 1_000, kind: `auth` as const, message: `401 OAuth access token has been revoked.`, account: `a` };
        const note = refusalNote(refusal, [reading({ account: `b`, measuredAt: 500 })], 5_000);
        expect(note?.current).toBe(false);
        expect(note?.line).toBe(`Refused its credential just now — that account is no longer connected.`);
    });

    /* The condition is read off the record's `kind`, which the daemon derived from the SENTENCE rather than from
     * the frame code — this is the whole reason a spent Kimi plan stops telling the user to reconnect a healthy
     * account. While it stands, the provider's own words are printed verbatim: they are the only part naming
     * which pool. Once answered, the line says what has happened since and the words move to the hover — a
     * quoted 401 over an account that has been serving turns all afternoon is an alarm the reader learns to
     * ignore. */
    it(`quotes the provider while the refusal stands, and says what answered it once one has`, () => {
        const message = `API Error: 403 You've reached your usage limit for this billing cycle.`;
        expect(refusalNote({ at: 0, kind: `limit`, message }, [], 300_000)?.line).toBe(`Hit its usage limit 5m ago — ${message}`);
        expect(refusalNote({ at: 0, kind: `auth`, message: `token revoked` }, [], 300_000)?.line).toBe(
            `Refused its credential 5m ago — token revoked`,
        );

        const answered = refusalNote({ at: 0, kind: `auth`, message: `token revoked` }, [reading({ measuredAt: 1_000 })], 300_000);
        expect(answered?.line).toBe(`Refused its credential 5m ago — has authenticated fine since.`);
        // Kept whole, either way: the sentence is what a hover is for once it stops being the headline.
        expect(answered?.detail).toBe(`token revoked`);
        expect(refusalNote({ at: 0, kind: `limit`, message }, [reading({ measuredAt: 1_000 })], 300_000)?.line).toBe(
            `Hit its usage limit 5m ago — has had room since.`,
        );
    });

    /* A SPENT POOL IS NOT AN ALARM, and this is where that is enforced. It refills on the provider's own
     * schedule, the translator routes around it in the meantime, and spend is what a fleet looks like at the end
     * of a week — so raising it made this list grow to one line per account precisely when nothing was wrong,
     * burying the one entry (a credential that cannot be refreshed) that no amount of waiting fixes. Spend is
     * still counted and still dated; it is just counted, in the band it belongs to. */
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

    // Even a spent account whose credential IS dead belongs here — on the reauth, not on the spend.
    it(`raises a dead credential whatever its pools say`, () => {
        const summary = planLimitSummary([at(99, { id: `both`, needsReauth: true }), at(99, { id: `justSpent` })]);
        expect(summary.attention.map((row) => row.id)).toEqual([`both`]);
    });
});
