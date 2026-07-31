import {
    type AccountUsage,
    type AgentProvider,
    type OauthAccount,
    reportsPlanLimits,
    type TranslatorAccounts,
    type UsageWindow,
} from "@intentic/sandbox-contract";
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
export const usageTone = (percent: number): string =>
    percent >= SPENT_PERCENT ? `text-danger` : percent >= TIGHT_PERCENT ? `text-warning` : `text-link`;

/* Where "effectively spent" is defined, once. The account list dims a spent row and sinks it below the ones
 * with headroom, and the ring above it turns red — three decisions that have to agree, and did not while each
 * surface carried its own 90. TIGHT is the same idea one step earlier: the point at which an account stops
 * being one you'd start a long turn on. Named rather than left as the bare 75 this tone scale used to carry,
 * because the capacity counts below have to draw their bands on the SAME two thresholds. */
export const SPENT_PERCENT = 90;
export const TIGHT_PERCENT = 75;
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

/* ---- plan limits, as rows ---------------------------------------------------------------------------------
 * EVERY connection this sandbox holds, drawn from the same snapshot type — the projection behind the Usage
 * tab's meters, and the counterpart to the Agent tab's rings (AiAccountSection's rowsOf, which decorates the
 * same two lists with the same liveUsage merge).
 *
 * Both lists, because a sandbox's connections come two ways and the reader has one question: a provider's own
 * account (Claude) and a subscription the translator holds (ChatGPT, Google, Kimi, SuperGrok). The Usage tab
 * read only the first, and only through the STREAMED map at that — so Google's headroom, which the daemon
 * pulls and hands over on the account row, could not appear there however well it was read. One list, one
 * merge, one shape.
 *
 * An account with NO reading is a row too. Absence rendered as absence is indistinguishable from an account
 * with room to spare, and those mean opposite things — so the row is listed and says which of the two states
 * it is in: a plan that publishes no limits at all (`readable: false` — Kimi, SuperGrok), or one that simply
 * has not been measured yet. */

export interface PlanLimitPool {
    readonly kind: string;
    readonly label: string;
    // Rounded once here, so a meter's width and its printed number can't disagree.
    readonly percent: number;
    readonly resetsAt: number | undefined;
}

export interface PlanLimitRow {
    // Unique across providers: a native account id is a uuid, a routed one is an auth-file name unique only
    // within its own provider.
    readonly id: string;
    readonly provider: AgentProvider;
    readonly label: string;
    // Undefined ⇒ no reading at all; `readable` then says whether one is even obtainable.
    readonly percent: number | undefined;
    readonly pools: readonly PlanLimitPool[];
    // The pool the percentage came from — the one that will gate this account's next turn. Carried rather than
    // re-derived, so a summary line naming a pool and the meter under it can't pick different ones.
    readonly binding: PlanLimitPool | undefined;
    readonly measuredAt: number | undefined;
    readonly stale: boolean;
    readonly readable: boolean;
    // A credential that can no longer be refreshed. Nothing to do with headroom, everything to do with whether
    // this account can serve a turn — so it rides the same row and surfaces in the same attention list.
    readonly needsReauth: boolean;
}

const planLimitRow = (
    provider: AgentProvider,
    key: string,
    label: string,
    attached: AccountUsage | undefined,
    needsReauth: boolean,
): PlanLimitRow => {
    const usage = liveUsage(key, attached);
    const pools =
        usage === undefined
            ? []
            : orderedWindows(usage).map((pool) => ({
                  kind: pool.kind,
                  label: usageWindowLabel(pool),
                  percent: Math.round(pool.utilization),
                  resetsAt: pool.resetsAt,
              }));
    // The fullest pool, off the rounded values the meters draw — an account is as constrained as its tightest
    // allowance, and reading that off `pools` is what keeps the headline number and its named pool the same one.
    const binding = pools.reduce<PlanLimitPool | undefined>(
        (worst, pool) => (worst === undefined || pool.percent > worst.percent ? pool : worst),
        undefined,
    );
    return {
        id: `${provider}:${key}`,
        provider,
        label,
        percent: binding?.percent,
        pools,
        binding,
        measuredAt: usage?.measuredAt,
        stale: usage !== undefined && isStale(usage),
        readable: reportsPlanLimits(provider),
        needsReauth,
    };
};

// Measured rows first, tightest of those at the top — the account about to gate a turn is the one worth seeing
// without scrolling. Unmeasured rows sink rather than sort as 0%: unknown is not headroom.
export const planLimitRows = (native: Record<string, readonly OauthAccount[]>, routed: TranslatorAccounts): PlanLimitRow[] =>
    [
        ...Object.entries(native).flatMap(([provider, accounts]) =>
            accounts.map((account) => planLimitRow(provider, account.id, account.label, account.usage, account.needsReauth === true)),
        ),
        // A routed subscription has no reauth flag of its own: CLIProxyAPI drops an auth file it can no longer
        // refresh, so a broken one leaves the list rather than sitting in it.
        ...Object.entries(routed).flatMap(([provider, accounts]) =>
            accounts.map((account) => planLimitRow(provider, account.name, account.label, account.usage, false)),
        ),
    ].toSorted((left, right) => {
        if (left.percent === undefined || right.percent === undefined) {
            return left.percent === right.percent ? left.label.localeCompare(right.label) : left.percent === undefined ? 1 : -1;
        }
        return right.percent - left.percent || left.label.localeCompare(right.label);
    });

/* ---- plan limits, aggregated ------------------------------------------------------------------------------
 * What a row list cannot answer once there are dozens of accounts. This sandbox holds 36 connections, 31 of
 * them Google, and a row each is 36 restatements of a question nobody asked: the operator picks a PROVIDER, and
 * the translator balances turns across that provider's accounts. So the unit of the screen is the provider, and
 * the unit of the fleet's capacity is a COUNT of accounts by band.
 *
 * Counts, never a mean utilization. Averaging 31 separate pools produces a number that describes no account and
 * hides the only one that matters — 30 idle accounts and one spent one is not "3% used", it is "one account you
 * can't use". Each band is a decision: run on it, avoid a long turn on it, don't route to it, or don't know. */

// Ordered worst-first: the same order the segments are drawn and the counts are read in, so the bar, the legend
// and the sentence can't disagree about which end is bad.
export const PLAN_LIMIT_BANDS = [`spent`, `tight`, `room`, `unread`, `none`] as const;
export type PlanLimitBand = (typeof PLAN_LIMIT_BANDS)[number];

// `none` is not a degree of fullness — it is a plan that publishes no limits at all (Kimi, SuperGrok), and it
// stays out of the capacity bar for that reason: an account whose headroom is unknowable is not headroom.
export const planLimitBand = (row: PlanLimitRow): PlanLimitBand => {
    if (row.percent === undefined) {
        return row.readable ? `unread` : `none`;
    }
    return row.percent >= SPENT_PERCENT ? `spent` : row.percent >= TIGHT_PERCENT ? `tight` : `room`;
};

// The words a count is read with. Sentence fragments, not headings: they are consumed as "3 with room · 1 tight".
export const PLAN_LIMIT_BAND_LABEL: Record<PlanLimitBand, string> = {
    spent: `spent`,
    tight: `tight`,
    room: `with room`,
    unread: `unread`,
    none: `no published limits`,
};

/* Severity for a band, on the same three tones a percentage wears everywhere else — so the capacity bar and the
 * meters under it mean the same thing by the same colour. `unread` and `none` take the achromatic slot on
 * purpose: they are the absence of a reading, and giving them a hue would seat them on the severity scale. */
export const planLimitBandTone = (band: PlanLimitBand): string =>
    band === `spent` ? `text-danger` : band === `tight` ? `text-warning` : band === `room` ? `text-link` : `text-muted`;

export type PlanLimitCounts = Record<PlanLimitBand, number>;

const countBands = (rows: readonly PlanLimitRow[]): PlanLimitCounts => {
    const counts: PlanLimitCounts = { spent: 0, tight: 0, room: 0, unread: 0, none: 0 };
    for (const row of rows) {
        counts[planLimitBand(row)] += 1;
    }
    return counts;
};

// The soonest pool to reopen, in epoch seconds — the one number that answers "when does capacity come back".
// Past resets are ignored rather than reported: a window whose instant has passed describes a pool that has
// already reopened, and naming it would send a reader to wait for something that already happened.
const nextReset = (rows: readonly PlanLimitRow[], now: number): number | undefined => {
    const upcoming = rows.flatMap((row) =>
        row.pools.flatMap((pool) => (pool.resetsAt !== undefined && pool.resetsAt * 1000 > now ? [pool.resetsAt] : [])),
    );
    return upcoming.length === 0 ? undefined : Math.min(...upcoming);
};

export interface PlanLimitGroup {
    readonly provider: AgentProvider;
    readonly rows: readonly PlanLimitRow[];
    readonly counts: PlanLimitCounts;
    // The account that gates this provider first — what the group row states instead of a percentage of its own.
    readonly tightest: PlanLimitRow | undefined;
    readonly nextResetAt: number | undefined;
}

// One group per provider, each group's most-constrained account first, and the groups themselves ordered by how
// close they are to gating a turn. A provider with no reading at all sinks below every provider that has one —
// the same rule the rows follow, one level up.
export const planLimitGroups = (rows: readonly PlanLimitRow[], now: number = Date.now()): PlanLimitGroup[] => {
    const byProvider = new Map<AgentProvider, PlanLimitRow[]>();
    for (const row of rows) {
        const group = byProvider.get(row.provider) ?? [];
        group.push(row);
        byProvider.set(row.provider, group);
    }
    return [...byProvider.entries()]
        .map(([provider, groupRows]): PlanLimitGroup => {
            const tightest = groupRows.find((row) => row.percent !== undefined);
            return { provider, rows: groupRows, counts: countBands(groupRows), tightest, nextResetAt: nextReset(groupRows, now) };
        })
        .toSorted((left, right) => (right.tightest?.percent ?? -1) - (left.tightest?.percent ?? -1) || left.provider.localeCompare(right.provider));
};

export interface PlanLimitSummary {
    readonly accounts: number;
    readonly counts: PlanLimitCounts;
    readonly nextResetAt: number | undefined;
    // Only what a person has to act on: an account that can't serve a turn, or one that can't be authenticated.
    // Never the healthy ones — a list of everything is what this section is trying to stop being.
    readonly attention: readonly PlanLimitRow[];
}

export const planLimitSummary = (rows: readonly PlanLimitRow[], now: number = Date.now()): PlanLimitSummary => ({
    accounts: rows.length,
    counts: countBands(rows),
    nextResetAt: nextReset(rows, now),
    attention: rows.filter((row) => row.needsReauth || planLimitBand(row) === `spent`),
});
