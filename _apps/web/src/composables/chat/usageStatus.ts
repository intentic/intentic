import type { AccountUsage, UsageWindow } from "@intentic/sandbox-contract";
import { ref } from "vue";

// The latest subscription usage snapshot PER ACCOUNT — every plan-limit window the provider reports, together.
// Two writers, both keyed by the account the daemon says served the turn: the agent event stream (the
// `account_usage` frame, read from the CLI's usage endpoint at turn end) and the daemon's persisted snapshots,
// which ride the `/accounts` list so a fresh page load already knows each account's headroom instead of staying
// blank until that account's next turn. Account-wide within an account, not per-conversation — the last turn on
// any tab updates its account's entry. A module singleton so the composer chip, the rate-limit notice, and the
// account picker can read it without threading it through each conversation.
export const usageStatusByAccount = ref<Record<string, AccountUsage>>({});

// The usage snapshot for an account, if one has been reported.
export const usageStatusFor = (account: string | undefined): AccountUsage | undefined =>
    account !== undefined ? usageStatusByAccount.value[account] : undefined;

/* Naming the pools. Every one of these is a SEPARATE allowance, and conflating two of them is exactly the bug
 * this vocabulary exists to prevent: an account can sit at 1% of its weekly Opus pool while its weekly
 * all-models pool is at 98%, and calling either of them "Weekly limit" makes the screen lie. The provider's own
 * display name wins where it gives one (the per-model buckets do), because those names are its to change. */
const WINDOW_NAMES: Record<string, string> = {
    five_hour: `5-hour session`,
    seven_day: `Weekly · all models`,
    seven_day_opus: `Weekly · Opus`,
    seven_day_sonnet: `Weekly · Sonnet`,
    seven_day_oauth_apps: `Weekly · third-party apps`,
    seven_day_overage_included: `Weekly · included overage`,
    overage: `Overage credits`,
};

export const usageWindowLabel = (window: UsageWindow): string =>
    window.label !== undefined
        ? window.kind.startsWith(`model:`)
            ? `Weekly · ${window.label}`
            : window.label
        : (WINDOW_NAMES[window.kind] ?? window.kind);

// Display order: the window that bites soonest first, then the broad weekly pool, then the per-model ones, then
// anything the provider has added since. Stable across accounts so rows line up when several are listed.
const WINDOW_ORDER = [`five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, `seven_day_oauth_apps`];
export const orderedWindows = (usage: AccountUsage): UsageWindow[] =>
    usage.windows.toSorted((left, right) => {
        const rank = (window: UsageWindow): number => {
            const index = WINDOW_ORDER.indexOf(window.kind);
            return index === -1 ? WINDOW_ORDER.length : index;
        };
        return rank(left) - rank(right) || usageWindowLabel(left).localeCompare(usageWindowLabel(right));
    });

// The pool that will gate the next turn: the fullest one. A single headroom number can only ever be this one —
// the account is as constrained as its tightest allowance, whichever that happens to be today.
export const bindingWindow = (usage: AccountUsage | undefined): UsageWindow | undefined =>
    usage?.windows.reduce<UsageWindow | undefined>(
        (worst, window) => (worst === undefined || window.utilization > worst.utilization ? window : worst),
        undefined,
    );

// The one-number summary a chip or a picker row shows. Undefined when the account has no usable reading — never
// measured, or every window it had has since reset — so the row shows nothing rather than a confident 0%.
export const usagePercent = (usage: AccountUsage | undefined): number | undefined => {
    const window = bindingWindow(usage);
    return window === undefined ? undefined : Math.round(window.utilization);
};

/* Severity, shared by every surface that draws one of these numbers, so a percentage never means one thing in
 * the composer and another on the Usage tab. Danger is reserved for a pool that is effectively spent. */
export const usageTone = (percent: number): string => (percent >= SPENT_PERCENT ? `text-danger` : percent >= 75 ? `text-warning` : `text-link`);

/* Where "effectively spent" is defined, once. The account list dims a spent row and sinks it below the ones
 * with headroom, and the ring above it turns red — three decisions that have to agree, and did not while each
 * surface carried its own 90. */
export const SPENT_PERCENT = 90;
export const isSpent = (usage: AccountUsage | undefined): boolean => {
    const percent = usagePercent(usage);
    return percent !== undefined && percent >= SPENT_PERCENT;
};

/* The freshest reading for an account, given what the server attached to its row. Both sources are the same
 * AccountUsage; they differ only in how they arrive. The daemon's rides the accounts list (any provider — a
 * Claude snapshot it persisted, a routed subscription's quota it pulled), while the streamed one is pushed by a
 * turn ending in THIS tab, which no list fetched a moment earlier can know about. Newer `measuredAt` wins,
 * which for every provider but Claude simply means the daemon's. */
export const liveUsage = (account: string, attached: AccountUsage | undefined): AccountUsage | undefined => {
    const streamed = usageStatusByAccount.value[account];
    if (streamed === undefined || attached === undefined) {
        return streamed ?? attached;
    }
    return streamed.measuredAt >= attached.measuredAt ? streamed : attached;
};

export interface UsageRing {
    percent: number;
    tone: string;
    tooltip: string;
}

/* An account's headroom as a ring: the one number, its severity, and the full per-pool breakdown behind it.
 * Undefined only when there is NO reading — that is the state the connection row answers with a plain dot, and
 * it must stay distinguishable from a measured 0%.
 *
 * The `?? 0` is the one deliberate difference from the composer chip. `usagePercent` returns undefined when
 * every window has reset (an empty array), which is right for a chip that should not be pinned by a stale
 * reading — but wrong for an account row, where a reset account IS at 0%: it was measured, its pools reopened,
 * and "you have room" beats "we don't know". */
export const usageRing = (usage: AccountUsage | undefined): UsageRing | undefined => {
    if (usage === undefined) {
        return undefined;
    }
    const percent = usagePercent(usage) ?? 0;
    return { percent, tone: usageTone(percent), tooltip: usageDetail(usage) };
};

// Format an epoch-seconds reset instant as a short local weekday + time (e.g. "Mon 3:20 PM") — unambiguous for
// both the 5-hour and weekly windows without a ticking relative clock.
export const formatReset = (epochSeconds: number): string =>
    new Date(epochSeconds * 1000).toLocaleString([], { weekday: `short`, hour: `numeric`, minute: `2-digit` });

/* The same instant as a RELATIVE wait, for the outage retry — where a wall-clock time would be the wrong answer
 * to the right question. A limit reset is hours out, so naming the hour lets someone decide whether to wait; an
 * outage retry is thirty seconds to twenty minutes out, and "Tue 9:41 PM" makes the reader do arithmetic to learn
 * something they'd have understood instantly as "about 30s".
 *
 * Deliberately coarse ("about"), and not a ticking countdown: the schedule has jitter and the daemon polls on its
 * own cadence, so a second-accurate clock here would be precision this cannot honour. The live countdown belongs
 * on the in-turn retry status, where the harness really does name its own next attempt. */
export const formatWait = (epochSeconds: number, now: number = Date.now()): string => {
    const seconds = Math.max(0, Math.round((epochSeconds * 1000 - now) / 1000));
    if (seconds < 90) {
        return `about ${Math.max(5, Math.round(seconds / 5) * 5)}s`;
    }
    return `about ${Math.round(seconds / 60)} min`;
};

// How old a snapshot is, coarsely. A reading is taken at the end of a turn, so an idle sandbox's is as old as
// its last turn — and utilization only ever climbs within a window, so the number is a floor, not a live figure.
export const formatAge = (measuredAt: number, now: number = Date.now()): string => {
    const minutes = Math.floor((now - measuredAt) / 60_000);
    if (minutes < 2) {
        return `just now`;
    }
    if (minutes < 60) {
        return `${minutes}m ago`;
    }
    const hours = Math.floor(minutes / 60);
    return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
};

/* Past this, a reading stops being a figure and becomes a FLOOR. Two reasons it can only ever climb away from
 * us: utilization never falls inside a window, and these pools are ACCOUNT-wide — another Claude Code, the
 * desktop app, claude.ai itself all spend the same allowance without this sandbox hearing about it. Ten minutes
 * is roughly "since the last turn": inside that, the reading is what the provider just told us. */
const STALE_AFTER_MS = 10 * 60_000;
export const isStale = (usage: AccountUsage, now: number = Date.now()): boolean => now - usage.measuredAt > STALE_AFTER_MS;

// A percentage, marked as a floor when the reading is old enough to have been overtaken elsewhere.
export const formatUtilization = (percent: number, stale: boolean): string => `${stale ? `≥` : ``}${percent}%`;

// The compact tooltip: every pool with its reset, then how stale the whole reading is. All of them, because
// "which pool is binding" is the question the single number can't answer — and the reset rides in parentheses
// because "wait 20 minutes" and "wait until Thursday" are different answers to the same percentage.
export const usageDetail = (usage: AccountUsage): string =>
    [
        ...orderedWindows(usage).map(
            (window) =>
                `${usageWindowLabel(window)} ${formatUtilization(Math.round(window.utilization), isStale(usage))}` +
                (window.resetsAt === undefined ? `` : ` (resets ${formatReset(window.resetsAt)})`),
        ),
        `measured ${formatAge(usage.measuredAt)}`,
    ].join(` · `);
