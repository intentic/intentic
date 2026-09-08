import { type AgentProvider, SPENT_UTILIZATION } from "@intentic/sandbox-contract";
import { providerAccounts, providerRefusals, translatorAccounts } from "../accounts/providerAccounts";
import { providerDisplayLabel } from "../accounts/providerCatalog";
import { type PlanLimitGroup, planLimitGroups, type PlanLimitPool, type PlanLimitRow, planLimitRows, poolPeriod, poolScope } from "../session/usageStatus";

// Projection behind ChatCapacityRail.vue for the popped-out chat: not the Usage tab's full reconciliation, but what has
// room to start the next task right now. Reads module state, not the current conversation's provider.

// How many accounts of one provider get a row before the rest are counted instead.
const ROWS_PER_PROVIDER = 3;

// Which of two kinds of nothing to report: never publishes limits, or not read yet.
const NO_LIMITS = `no published limits`;
const UNREAD = `no reading yet`;

/** One allowance on one account: its bar, the window it measures, and that window's full name. */
export interface CapacityLane {
    // The pool's own key, unique within an account; used as the list key.
    readonly kind: string;
    // This window's length in its shortest identifying form: "5h", "wk", "12h".
    readonly short: string;
    // What it's metered for when less than everything ("Opus"); undefined when the pool gates every model.
    readonly scope: string | undefined;
    // The provider's full name for this window, for hover text and spoken sentences.
    readonly label: string;
    readonly percent: number;
    readonly resetsAt: number | undefined;
}

/** One offer as the rail draws it: a name, plus one bar per allowance the plan publishes. */
export interface CapacityRow {
    readonly id: string;
    // Undefined when the heading above already names this row (one account, or a pooled routed provider).
    readonly label: string | undefined;
    // Sign-in identity, shown only on hover, for when the label alone doesn't say which account this is.
    readonly identity: string | undefined;
    // Room for the roomiest runnable thing (openPercent), not the tightest lane; undefined = nothing measured.
    readonly percent: number | undefined;
    // One per allowance that can gate a turn, shortest window first; empty means nothing was measured.
    readonly lanes: readonly CapacityLane[];
    // Why there are no lanes; never a pool's name, since drawn lanes already name themselves.
    readonly note: string;
    readonly stale: boolean;
}

export interface CapacityProvider {
    readonly provider: AgentProvider;
    readonly label: string;
    readonly rows: readonly CapacityRow[];
    // Accounts that can serve now, and how many the provider holds in total; equal-and-one prints no count.
    readonly ready: number;
    readonly total: number;
    // Accounts with room that were not drawn a row; never a silent cap.
    readonly hidden: number;
    // True when the translator spreads turns across these accounts itself, so the rows are one, not a choice.
    readonly pooled: boolean;
}

/** A provider with nothing left to offer, and what it is waiting on. */
export interface CapacityOut {
    readonly provider: AgentProvider;
    readonly label: string;
    // Short footnote text; never the provider's own long refusal sentence, which lives in `detail`.
    readonly reason: string;
    // When the soonest spent pool reopens; undefined means waiting will not fix it.
    readonly reopensAt: number | undefined;
    // The provider's own refusal words, shown on hover where the line is too narrow to carry them.
    readonly detail: string | undefined;
}

export interface ChatCapacity {
    // Roomiest provider first.
    readonly providers: readonly CapacityProvider[];
    // Lets a reader tell a spent provider from one they never connected.
    readonly out: readonly CapacityOut[];
    // Credentials needing a person; counted, not listed, since the fix lives on the Agent tab.
    readonly needsReauth: number;
    // Oldest reading on screen, not the freshest, since it qualifies every bar shown under it.
    readonly measuredAt: number | undefined;
}

// The tightest pool that gates every model, or, if none gates everything, the roomiest scoped pool; undefined when
// nothing was measured.
const openPercent = (pools: readonly PlanLimitPool[]): number | undefined => {
    const gating = pools.filter((pool) => pool.gates !== `none`);
    const everything = gating.filter((pool) => pool.gates === `all`).map((pool) => pool.percent);
    if (everything.length > 0) {
        return Math.max(...everything);
    }
    const scoped = gating.map((pool) => pool.percent);
    return scoped.length === 0 ? undefined : Math.min(...scoped);
};

// True once every runnable pool has reached the wire's own SPENT_UTILIZATION, not the app's 90% warning line; a pool
// between the two stays listed and merely wears red.
const spentOutright = (row: PlanLimitRow): boolean => {
    const open = openPercent(row.pools);
    return open !== undefined && open >= SPENT_UTILIZATION;
};

// A native refusal excludes the one account it names; a routed refusal names none and excludes the whole provider. A
// `limit` refusal doesn't count here since it already shows up in the pool's percentage.
interface Refused {
    readonly all: boolean;
    readonly one: string | undefined;
}

const refusedAccounts = (group: PlanLimitGroup): Refused => {
    const refusal = providerRefusals.value[group.provider];
    if (group.refusal?.current !== true || refusal === undefined || refusal.kind === `limit`) {
        return { all: false, one: undefined };
    }
    return refusal.account === undefined ? { all: true, one: undefined } : { all: false, one: group.refusedRow?.id };
};

// Four ways to be unusable: spent (waits), a rejected credential, a standing refusal, or benched by the translator. No
// reading at all is still usable; unknown is not exhausted.
const canServe = (row: PlanLimitRow, refused: Refused): boolean => {
    if (row.needsReauth || row.cooling !== undefined || refused.all || refused.one === row.id) {
        return false;
    }
    return !spentOutright(row);
};

// Roomiest first; a row with no reading sorts after every measured row, never as headroom. Ties break by label so the
// column holds still between reads.
const byRoom = (left: PlanLimitRow, right: PlanLimitRow): number => {
    const [leftRoom, rightRoom] = [openPercent(left.pools), openPercent(right.pools)];
    if (leftRoom === undefined || rightRoom === undefined) {
        return leftRoom === rightRoom ? left.label.localeCompare(right.label) : leftRoom === undefined ? 1 : -1;
    }
    return leftRoom - rightRoom || left.label.localeCompare(right.label);
};

// Falls back to the sign-in identity only when two accounts share a label, and only as a tiebreak: a renamed label is
// never overridden.
const displayName = (row: PlanLimitRow, ambiguous: ReadonlySet<string>): string =>
    ambiguous.has(row.label) ? (row.identity ?? row.label) : row.label;

const ambiguousLabels = (rows: readonly PlanLimitRow[]): ReadonlySet<string> => {
    const seen = new Map<string, number>();
    for (const row of rows) {
        seen.set(row.label, (seen.get(row.label) ?? 0) + 1);
    }
    return new Set([...seen].filter(([, count]) => count > 1).map(([label]) => label));
};

// One lane per pool that gates something, shortest window first, tightest first within a window. No cap: plans publish
// few enough pools that summarizing one would hide the one about to gate a turn.
const capacityLanes = (row: PlanLimitRow): readonly CapacityLane[] =>
    row.pools
        .filter((pool) => pool.gates !== `none`)
        .map((pool) => {
            const period = poolPeriod(pool);
            return {
                lane: {
                    kind: pool.kind,
                    // Falls back to the pool's own label when the period can't be read; the column truncates it.
                    short: period?.short ?? pool.label,
                    scope: period === undefined ? undefined : poolScope(pool),
                    label: pool.label,
                    percent: pool.percent,
                    resetsAt: pool.resetsAt,
                },
                // Unreadable periods sort last, not as zero-length.
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
    // Omitted when it matches the label already shown, to avoid repeating it on hover.
    identity: row.identity === label ? undefined : row.identity,
    percent: openPercent(row.pools),
    lanes: capacityLanes(row),
    note: row.readable ? UNREAD : NO_LIMITS,
    stale: row.stale,
});

const capacityProvider = (group: PlanLimitGroup, ready: readonly PlanLimitRow[]): CapacityProvider => {
    // A routed pool or a lone account is one row either way, since the heading already names what the bar measures.
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

// Order a reader can act on; spend comes first since naming it also gives the reopen instant. A dead credential is
// reported separately via `needsReauth`.
const outReason = (group: PlanLimitGroup, refused: Refused): string => {
    // Same exhaustion test as the row list; a slice that never gated anything can't read a provider as spent.
    if (group.rows.some(spentOutright)) {
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

// Soonest pool that is actually full, not the soonest of all of them (the 5-hour window resets within the hour
// regardless). Past instants are ignored: they describe a pool that has already reopened.
const reopensAt = (group: PlanLimitGroup, now: number): number | undefined => {
    const upcoming = group.rows.flatMap((row) => [
        ...row.pools.flatMap((pool) =>
            pool.percent >= SPENT_UTILIZATION && pool.resetsAt !== undefined && pool.resetsAt * 1000 > now ? [pool.resetsAt] : [],
        ),
        // The translator's own retry instant for a benched credential, the same kind of promise as a reset.
        ...(row.cooling?.until !== undefined && row.cooling.until * 1000 > now ? [row.cooling.until] : []),
    ]);
    return upcoming.length === 0 ? undefined : Math.min(...upcoming);
};

// Roomiest offer ranks the provider; an unmeasured provider sorts last, never as a zero.
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

// Whether the panel should reserve the rail's strip before layout runs, so it must know before anything is drawn.
export const hasCapacity = (): boolean => planLimitRows(providerAccounts.value, translatorAccounts.value).length > 0;

// Only claims width no pane needs: past the 52.5rem reading measure (`.chat-turns`) a pane is just centring. That
// per-pane surplus, measured off the panel and the chat list's live width in app pixels, is what the rail may take.
export const CAPACITY_RAIL_PX = 240;
const PANE_COMFORT_PX = 872;

export const railFitsBeside = (panelPx: number, listRailPx: number, panes: number): boolean =>
    panelPx - listRailPx - CAPACITY_RAIL_PX >= panes * PANE_COMFORT_PX;
