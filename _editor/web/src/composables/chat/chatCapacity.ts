import type { AgentProvider } from "@intentic/sandbox-contract";
import { providerAccounts, providerRefusals, translatorAccounts } from "./providerAccounts";
import { providerDisplayLabel } from "./providerCatalog";
import { type PlanLimitGroup, planLimitGroups, type PlanLimitRow, planLimitRows, poolPeriod, poolScope, SPENT_PERCENT } from "./usageStatus";

/* WHAT CAN I START THE NEXT TASK ON, as a column narrow enough to stand beside a transcript.
 *
 * The projection behind the popped-out chat's right-hand rail (chat/ChatCapacityRail.vue). Every fact in it
 * already exists on the Usage tab; what is new is the QUESTION. The Usage tab answers "reconcile my fleet":
 * every account, every pool, every reset, what is broken. This answers the one thing a person about to type a
 * prompt wants, which is strictly smaller and shaped differently: which of my subscriptions still has room, and
 * how much.
 *
 * Three rules follow from that, and each of them is why this is not planLimitRows in a narrow box:
 *
 *   1. A SPENT ACCOUNT IS NOT ON THE LIST. The list is offers, and an account at 97% is not one. But it is not
 *      silently dropped either: a provider with nothing left is named on the footnote with the instant it comes
 *      back, because "Claude isn't here" and "Claude is spent until Sunday" are opposite states and the absence
 *      of a row cannot tell them apart.
 *   2. SPENT IS NOT THE ONLY WAY TO BE UNUSABLE. A dead credential publishes full pools right up to the moment
 *      it turns every turn away, and an organization that has switched the harness off for a seat publishes
 *      them forever. Either would draw a confident green bar over an account that cannot serve anything, which
 *      is the exact defect the composer's own account rows were built to end. So a standing refusal and a
 *      needs-reconnecting flag hold an account off the list as firmly as a full pool does.
 *   3. AN ACCOUNT IS AS MANY ALLOWANCES AS IT PUBLISHES, and every one of them is drawn. A subscription is not
 *      one pool: it is a 5-hour session AND a week, and on some plans a per-model slice of that week besides.
 *      They run out independently and they come back at completely different times, so a single number — the
 *      tightest, which is what everything else in this app shows — leaves the reader unable to tell the two
 *      states apart that decide what to do next: an hour's wait, or a week's rationing. The rail draws a lane
 *      per pool, named by the LENGTH of its window (usageStatus' poolPeriod), which is the only part of a
 *      pool's name that fits here and the only part that says what the percentage costs.
 *   4. A POOL NOBODY PICKS AMONG IS ONE OFFER, NOT THIRTY-ONE. This sandbox holds 31 Google sign-ins that
 *      CLIProxyAPI balances turns across by itself: the reader does not choose between them and cannot act on
 *      any one of them, so a row each would spend the whole rail restating one fact per gmail address. A routed
 *      provider is one row, standing at its roomiest reading. A provider whose accounts ARE choosable (the
 *      composer's footer offers them by name) gets a row each, capped, because there the account is a decision.
 *
 * Everything here reads MODULE state and belongs to no conversation: this is a reading of the sandbox, and the
 * chat it happens to sit beside does not narrow it. That is deliberate. The composer's picker already answers
 * "who serves THIS turn"; a reader looking at this rail is deciding what to start next, which may well be on a
 * provider the chat beside it is not using. */

/* HOW MANY ACCOUNTS OF ONE PROVIDER GET A ROW. Three logins are three offers and every one of them fits; past
 * that the column stops being scannable and the extras are counted instead. The same number, for the same
 * reason, the Usage tab draws meters inline up to (PlanLimitsPanel's INLINE_LIMIT). */
const ROWS_PER_PROVIDER = 3;

// What the second line says when there is no percentage to print: which of the two kinds of nothing this is.
// They lead to opposite moves — one is a plan that will never publish a figure, the other is a reading to take.
const NO_LIMITS = `no published limits`;
const UNREAD = `no reading yet`;

/** One allowance of one account: a bar, the window it measures, and what that window is called in full. */
export interface CapacityLane {
    // The pool's own key, unique within an account, which is what makes it the list key.
    readonly kind: string;
    // How long this window is, in the shortest form that still identifies it: "5h", "wk", "12h".
    readonly short: string;
    // What it is metered for, when it is metered for less than everything ("Opus", "Gemini"). Undefined for a
    // pool that gates every model, where the period alone names it. See usageStatus' poolScope.
    readonly scope: string | undefined;
    // The provider's whole name for it ("Weekly · all models"), for the hover and the spoken sentence.
    readonly label: string;
    readonly percent: number;
    readonly resetsAt: number | undefined;
}

/** One offer, as the rail draws it: a name, and a bar per allowance the plan publishes for it. */
export interface CapacityRow {
    readonly id: string;
    /* The account's own name, or undefined when the heading above already names this row: a provider holding
     * one account, and a routed pool, where the row IS the provider (see `pooled`). Printing a gmail address
     * under "Gemini" when that address is not a choice reads as "this one account is what you have". */
    readonly label: string | undefined;
    /* Who this account signs in as, when the label does not already say it. It rides the hover rather than the
     * line, because at this width there is one line: a label the user chose is what they asked to see, and the
     * email behind it is what answers "which one is that" when the label turns out not to. */
    readonly identity: string | undefined;
    /* WHAT RANKS THIS ROW: the binding pool's figure, the tightest of the lanes below, since an account is as
     * constrained as its worst allowance. Undefined ⇒ no reading at all, and then there are no lanes either:
     * an empty track and a measured 0% are opposite claims, and `note` says which kind of nothing this is. */
    readonly percent: number | undefined;
    // One per allowance that can gate a turn, shortest window first. Empty ⇒ nothing was measured.
    readonly lanes: readonly CapacityLane[];
    // Why there are no lanes. Never a pool's name: with lanes drawn, the pools name themselves.
    readonly note: string;
    readonly stale: boolean;
}

export interface CapacityProvider {
    readonly provider: AgentProvider;
    readonly label: string;
    readonly rows: readonly CapacityRow[];
    // How many of this provider's accounts can serve a turn right now, and how many it holds. Equal and one is
    // the case that prints no count at all: "1 of 1" is a fact nobody came here for.
    readonly ready: number;
    readonly total: number;
    // Accounts with room that no row was drawn for. Never a silent cap.
    readonly hidden: number;
    // Turns are spread across these by the translator, so nothing here is a choice and the rows are one.
    readonly pooled: boolean;
}

/** A provider with nothing left to offer, and the one thing worth saying about it: what it is waiting on. */
export interface CapacityOut {
    readonly provider: AgentProvider;
    readonly label: string;
    // The words the footnote prints after the name. Never the provider's own sentence: that runs to a paragraph
    // with a pricing URL on the end, and it lives on the hover (`detail`) and in full on the Usage tab.
    readonly reason: string;
    // When its soonest spent pool reopens, when waiting is what it takes. Undefined ⇒ waiting will not fix it.
    readonly reopensAt: number | undefined;
    // The provider's own words, when it refused. The hover behind a line too narrow to carry them.
    readonly detail: string | undefined;
}

export interface ChatCapacity {
    // Most room first: the provider you would reach for, at the top, without reading a number.
    readonly providers: readonly CapacityProvider[];
    /* The counterpart to rule 1 above — what turns a list of offers back into an account of the whole fleet, so
     * a reader can tell a spent provider from one they never connected. */
    readonly out: readonly CapacityOut[];
    // Credentials that need a person. Counted, not listed: the fix is on the Agent tab and this is a readout.
    readonly needsReauth: number;
    /* The OLDEST reading on screen, never the freshest: the header's age qualifies every bar under it, and a
     * header vouching for its best row would be vouching for a stale one sitting directly beneath. */
    readonly measuredAt: number | undefined;
}

/* WHICH ACCOUNTS A REFUSAL TAKES OFF THE LIST, which is not always the one it names.
 *
 * A native turn names the account it was serving, and only that one is out. A ROUTED turn names nobody, and
 * that silence is informative rather than missing: CLIProxyAPI picks the auth file itself and only refuses once
 * every credential it holds is cooling down, so an unattributed refusal means the whole provider is out.
 * Reading it the other way (nobody named ⇒ nobody affected) is what would put thirty-one green bars under a
 * provider that had just turned the reader's last turn away.
 *
 * Only while the refusal STANDS. `refusalNote` has already read it against everything measured since, and an
 * answered refusal is history: holding an account off the list over a 401 that three later readings disproved
 * is the same error from the other end. */
interface Refused {
    readonly all: boolean;
    readonly one: string | undefined;
}

const refusedAccounts = (group: PlanLimitGroup): Refused => {
    if (group.refusal?.current !== true) {
        return { all: false, one: undefined };
    }
    const named = providerRefusals.value[group.provider]?.account;
    return named === undefined ? { all: true, one: undefined } : { all: false, one: group.refusedRow?.id };
};

/* CAN THIS ACCOUNT SERVE THE NEXT TURN. Four ways to be unusable, and they are genuinely different facts: a
 * spent pool (waits), a rejected credential (needs a person), a standing refusal (needs a person or a plan),
 * and the translator's own bench of a routed credential (waits, on the proxy's clock, and is the freshest fact
 * of the four). An account with NO reading is usable: a plan that publishes no limits (SuperGrok) and one that
 * has not been measured yet are both unknown, and unknown is not exhausted. Saying otherwise would hide the one
 * provider a reader has left on a week when everything measurable is spent. */
const canServe = (row: PlanLimitRow, refused: Refused): boolean => {
    if (row.needsReauth || row.cooling !== undefined || refused.all || refused.one === row.id) {
        return false;
    }
    return row.percent === undefined || row.percent < SPENT_PERCENT;
};

// Most room first, and a row with no reading after every row that has one: unknown is not headroom, so it must
// not outrank a measured 4%. Ties by name, so the column holds still between readings.
const byRoom = (left: PlanLimitRow, right: PlanLimitRow): number => {
    if (left.percent === undefined || right.percent === undefined) {
        return left.percent === right.percent ? left.label.localeCompare(right.label) : left.percent === undefined ? 1 : -1;
    }
    return left.percent - right.percent || left.label.localeCompare(right.label);
};

/* WHAT TO CALL A ROW WHEN ITS NAME NAMES NOTHING. A label starts life as whatever the provider offered and is
 * the user's to change, so two sign-ins can both read "Claude" — and two rows reading "Claude" with different
 * bars is a column that has stopped answering the only question it was drawn to answer. The sign-in identity is
 * the tiebreak, and only a tiebreak: a reader who renamed an account "Work" asked for "Work", and swapping
 * their word for an email everywhere would undo that to fix a collision they do not have.
 *
 * The same rule the composer's own account rows follow (pickerAccounts' ambiguousLabels), reached differently
 * because this column has no room for a second line: there the identity goes UNDER the name, here it replaces
 * a name that has stopped being one. */
const displayName = (row: PlanLimitRow, ambiguous: ReadonlySet<string>): string =>
    ambiguous.has(row.label) ? (row.identity ?? row.label) : row.label;

const ambiguousLabels = (rows: readonly PlanLimitRow[]): ReadonlySet<string> => {
    const seen = new Map<string, number>();
    for (const row of rows) {
        seen.set(row.label, (seen.get(row.label) ?? 0) + 1);
    }
    return new Set([...seen].filter(([, count]) => count > 1).map(([label]) => label));
};

/* THE ALLOWANCES THIS ACCOUNT ACTUALLY RUNS ON, one lane each, shortest window first and the tightest first
 * within a window.
 *
 * EVERY POOL, not the tightest one summarised: a week at 12% and an Opus slice at 84% are two different
 * sentences about what to do next, and folding them into one loses whichever the reader needed. There is no cap
 * on purpose. The list is bounded by what plans publish, two pools on nearly every account and four on the
 * fullest of them, and a cap would be a silent drop of an allowance that could stop the very next turn.
 *
 * A POOL THAT GATES NOTHING IS NOT AN ALLOWANCE HERE. ChatGPT's code-review limit and Claude's Cowork slice
 * belong to other products on the same plan (gates "none"): they are the account's to reconcile on the Usage
 * tab, and a lane for one would be a bar in a column that answers "what can I run" about something no turn
 * here spends. */
const capacityLanes = (row: PlanLimitRow): readonly CapacityLane[] =>
    row.pools
        .filter((pool) => pool.gates !== `none`)
        .map((pool) => {
            const period = poolPeriod(pool);
            return {
                lane: {
                    kind: pool.kind,
                    // A period this cannot read leaves the pool to introduce itself under its own name, which
                    // is the one thing certain to be right ("Throttle"), and the column truncates it.
                    short: period?.short ?? pool.label,
                    scope: period === undefined ? undefined : poolScope(pool),
                    label: pool.label,
                    percent: pool.percent,
                    resetsAt: pool.resetsAt,
                },
                // Unreadable periods sort last rather than as zero-length: an unknown window is not a short one.
                seconds: period?.seconds ?? Number.POSITIVE_INFINITY,
            };
        })
        .toSorted(
            (left, right) =>
                left.seconds - right.seconds || right.lane.percent - left.lane.percent || left.lane.label.localeCompare(right.lane.label),
        )
        .map((entry) => entry.lane);

const capacityRow = (row: PlanLimitRow, label: string | undefined): CapacityRow => ({
    id: row.id,
    label,
    // Only when it adds something: a row already printing the identity must not repeat it on the hover.
    identity: row.identity === label ? undefined : row.identity,
    percent: row.percent,
    lanes: capacityLanes(row),
    note: row.readable ? UNREAD : NO_LIMITS,
    stale: row.stale,
});

const capacityProvider = (group: PlanLimitGroup, ready: readonly PlanLimitRow[]): CapacityProvider => {
    /* A pool is one row whatever its size, and a lone account is one row because it has to be. Both are the
     * case where the heading already names what the bar measures, so the row carries no name of its own. */
    const pooled = ready[0]?.routed === true && group.rows.length > 1;
    const shown = pooled ? ready.slice(0, 1) : ready.slice(0, ROWS_PER_PROVIDER);
    const named = !pooled && group.rows.length > 1;
    const ambiguous = ambiguousLabels(group.rows);
    return {
        provider: group.provider,
        label: providerDisplayLabel(group.provider),
        rows: shown.map((row) => capacityRow(row, named ? displayName(row, ambiguous) : undefined)),
        ready: ready.length,
        total: group.rows.length,
        hidden: pooled ? 0 : ready.length - shown.length,
        pooled,
    };
};

/* WHY A PROVIDER IS OUT, in the order a reader can act on. Spend comes first because it is both the commonest
 * reason and the only one that fixes itself: naming it buys the reopen instant beside it, which is the whole
 * useful content of this line. A dead credential is reported separately anyway (`needsReauth`), so a provider
 * that is spent AND holds one broken sign-in still reads as spent, and the count below says the rest. */
const outReason = (group: PlanLimitGroup, refused: Refused): string => {
    if (group.rows.some((row) => row.percent !== undefined && row.percent >= SPENT_PERCENT)) {
        return `spent`;
    }
    if (group.rows.every((row) => row.needsReauth)) {
        return `sign-in expired`;
    }
    if (group.rows.every((row) => row.cooling !== undefined)) {
        return `cooling down`;
    }
    return refused.all || refused.one !== undefined ? `refused your last turn` : `nothing available`;
};

/* WHEN A SPENT PROVIDER COMES BACK: the soonest of the pools that are actually FULL, not the soonest of all of
 * them. Every account publishes a 5-hour window alongside its weekly one, and the 5-hour window reopens within
 * the hour whether or not it is the pool that ran out — so "reopens in 40 minutes" beside a weekly allowance
 * spent until Sunday is a promise the plan will not keep. Past instants are ignored rather than reported: a
 * window whose time has passed describes a pool that has already reopened. */
const reopensAt = (group: PlanLimitGroup, now: number): number | undefined => {
    const upcoming = group.rows.flatMap((row) => [
        ...row.pools.flatMap((pool) =>
            pool.percent >= SPENT_PERCENT && pool.resetsAt !== undefined && pool.resetsAt * 1000 > now ? [pool.resetsAt] : [],
        ),
        // The translator's own retry instant for a benched credential, the same kind of promise a reset is.
        ...(row.cooling?.until !== undefined && row.cooling.until * 1000 > now ? [row.cooling.until] : []),
    ]);
    return upcoming.length === 0 ? undefined : Math.min(...upcoming);
};

// A provider ranks by its roomiest offer, since that is the one a turn would land on. An unmeasured provider
// sorts past every measured one rather than as a zero: the same "unknown is not headroom" rule as the rows.
const roomOf = (entry: CapacityProvider): number => entry.rows[0]?.percent ?? Number.POSITIVE_INFINITY;

export const chatCapacity = (now: number = Date.now()): ChatCapacity => {
    const rows = planLimitRows(providerAccounts.value, translatorAccounts.value);
    const groups = planLimitGroups(rows, providerRefusals.value, now);
    const judged = groups.map((group) => {
        const refused = refusedAccounts(group);
        return { group, refused, ready: group.rows.filter((row) => canServe(row, refused)).toSorted(byRoom) };
    });
    const measured = rows.flatMap((row) => (row.measuredAt === undefined ? [] : [row.measuredAt]));
    return {
        providers: judged
            .flatMap((entry) => (entry.ready.length === 0 ? [] : [capacityProvider(entry.group, entry.ready)]))
            .toSorted((left, right) => roomOf(left) - roomOf(right) || left.label.localeCompare(right.label)),
        out: judged.flatMap((entry) =>
            entry.ready.length > 0
                ? []
                : [
                      {
                          provider: entry.group.provider,
                          label: providerDisplayLabel(entry.group.provider),
                          reason: outReason(entry.group, entry.refused),
                          reopensAt: reopensAt(entry.group, now),
                          detail: entry.group.refusal?.current === true ? entry.group.refusal.detail : undefined,
                      },
                  ],
        ),
        needsReauth: rows.filter((row) => row.needsReauth).length,
        measuredAt: measured.length === 0 ? undefined : Math.min(...measured),
    };
};

/* IS THERE ANYTHING TO DRAW, asked by the PANEL rather than by the rail itself. The panel is what pays for the
 * column — it reserves the strip the transcript may not use (ChatPanel's --capacity-rail) — so it has to know
 * before it lays anything out. A rail that decided its own emptiness one level down would leave the panel
 * holding 240px of padding open beside a chat with nothing standing in it, which is the one shape of this
 * feature that costs a reader width and gives them nothing back. */
export const hasCapacity = (): boolean => planLimitRows(providerAccounts.value, translatorAccounts.value).length > 0;

/* ---- when there is room for the rail at all ----------------------------------------------------------------
 *
 * THE RAIL IS SPARE WIDTH OR IT IS NOTHING. It stands in a window whose subject is the transcript, so the one
 * rule is that no pane pays for it: it appears only where the panes would otherwise be drawing margin.
 *
 * The reading measure is 52.5rem (chat.css's `.chat-turns`: a 48rem column plus its two 2.25rem gutters), and a
 * pane wider than that spends the difference on centring. So the comfort width below is that measure plus a rem
 * of air on each side — the point past which a pane's extra width is genuinely doing nothing, and the rail may
 * have what is left over. Under it the rail is not drawn and the pane keeps every pixel. Per pane, multiplied:
 * two transcripts side by side want the width twice, and a split that has only just fitted is not a window with
 * room to spare.
 *
 * MEASURED OFF THE PANEL, NOT THE WINDOW, and against the chat list's CURRENT width rather than its default:
 * the reader drags that rail, and a rule that assumed 320 would hand the panes 160px less than it promised to
 * anyone who had widened it. In app pixels, like every stored width in this app (uiScale.ts), so the whole rule
 * moves with the reader's text size instead of folding late for the reader with the least room to spare.
 *
 * There is deliberately NO dismiss control. A reader who does not want the rail makes it go away by dragging
 * the window narrower, and until they do it costs them nothing; a remembered preference here would be a hidden
 * state whose only symptom is a rail that never comes back. */
export const CAPACITY_RAIL_PX = 240;
const PANE_COMFORT_PX = 872;

export const railFitsBeside = (panelPx: number, listRailPx: number, panes: number): boolean =>
    panelPx - listRailPx - CAPACITY_RAIL_PX >= panes * PANE_COMFORT_PX;
