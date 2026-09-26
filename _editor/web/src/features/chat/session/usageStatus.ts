import {
    type AccountFix,
    type AccountState,
    type AccountUsage,
    type AgentProvider,
    bindingWindow,
    headroomState,
    type ModelRef,
    type OauthAccount,
    type ProviderRefusal,
    refusalVerdict,
    reportsPlanLimits,
    scopedWindow,
    type ServiceFacts,
    serviceStates,
    SPENT_UTILIZATION,
    type TranslatorAccounts,
    type UsageUnread,
    type UsageWindow,
    type WindowGates,
    windowPeriod,
    type WindowPeriod,
} from "@intentic/sandbox-contract";
import { formatWhen, timeAgo } from "@intentic/ui/format";
import { t } from "@intentic/ui/i18n";
import { lookupUsage, providerAccounts, providerRefusals, translatorAccounts } from "../accounts/providerAccounts";

// Re-exported so callers get the contract's binding-pool rule from this module too.
export { bindingWindow };

// One label per pool kind; provider's own name wins when given, since these are separate allowances.
const WINDOW_NAMES: Record<string, string> = {
    five_hour: `5-hour session`,
    seven_day: `Weekly · all models`,
    seven_day_opus: `Weekly · Opus`,
    seven_day_sonnet: `Weekly · Sonnet`,
    seven_day_oauth_apps: `Weekly · third-party apps`,
    seven_day_overage_included: `Weekly · included overage`,
    overage: `Overage credits`,
};

// Model/surface-scoped pools are weekly slices; labeled "Weekly · X" rather than a bare name.
const SCOPED_KINDS = [`model:`, `surface:`];
export const usageWindowLabel = (window: UsageWindow): string =>
    window.label !== undefined
        ? SCOPED_KINDS.some((prefix) => window.kind.startsWith(prefix))
            ? `Weekly · ${window.label}`
            : window.label
        : (WINDOW_NAMES[window.kind] ?? window.kind);

// Display order: soonest window first, then broad weekly, then per-model, then anything unrecognised.
const WINDOW_ORDER = [`five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, `seven_day_oauth_apps`];
export const orderedWindows = (usage: AccountUsage): UsageWindow[] =>
    usage.windows.toSorted((left, right) => {
        const rank = (window: UsageWindow): number => {
            const index = WINDOW_ORDER.indexOf(window.kind);
            return index === -1 ? WINDOW_ORDER.length : index;
        };
        return rank(left) - rank(right) || usageWindowLabel(left).localeCompare(usageWindowLabel(right));
    });

// The one-number summary for a chip or picker row: the model's pool when the surface names one, else the
// account's tightest. Undefined when unmeasured or every window has reset.
export const usagePercent = (usage: AccountUsage | undefined, model?: ModelRef): number | undefined => {
    const window = bindingWindow(usage, model);
    return window === undefined ? undefined : Math.round(window.utilization);
};

// Severity shared by every surface that draws a percentage, so it means the same thing everywhere. Danger is the
// contract's one spent line (SPENT_UTILIZATION), the same the daemon's pickers use; warning is only a tint on the way.
// The healthy tone is success green, the start of the drain ramp (meterTint), never the brand accent.
export const usageTone = (percent: number): string =>
    percent >= SPENT_UTILIZATION ? `text-danger` : percent >= TIGHT_PERCENT ? `text-warning` : `text-success`;

// Past this a pool is drawn as tight; never a verdict, which is the contract's alone.
const TIGHT_PERCENT = 75;
export const isSpent = (usage: AccountUsage | undefined, model?: ModelRef): boolean => headroomState(usage, model).kind === `spent`;

// Reading for an account: the shared map (providerAccounts.usageByAccount) if present, else the attached
// row a caller holds (used by planLimitRows). The map always wins: turns and daemon pushes keep it current.
const freshest = (provider: AgentProvider, account: string, attached: AccountUsage | undefined): AccountUsage | undefined =>
    lookupUsage(provider, account) ?? attached;

// A standing `limit` refusal reads its account's pool as full, since polled readings freeze the moment a pool
// actually empties. Keyed by provider: a routed refusal names no account, so it covers every credential the
// provider holds.
// Pins the pool binding the refused turn's model (`refusal.model`), else the model asked about, else the
// account's tightest — never a different allowance than the one that actually refused.
const spentByRefusal = (provider: AgentProvider, account: string, usage: AccountUsage | undefined, model: ModelRef | undefined): AccountUsage | undefined => {
    const refused = providerRefusals.value[provider]?.model;
    const binding = bindingWindow(usage, refused === undefined ? model : { id: refused });
    if (usage === undefined || binding === undefined || binding.utilization >= SPENT_UTILIZATION || !limitStandsFor(provider, account, usage)) {
        return usage;
    }
    return { ...usage, windows: usage.windows.map((entry) => (entry === binding ? { ...entry, utilization: SPENT_UTILIZATION } : entry)) };
};

// An account's reading as any surface should draw it: freshest data, corrected for what the plan has since
// refused. `model` picks which pool a refusal pins.
export const liveUsage = (provider: AgentProvider, account: string, attached?: AccountUsage, model?: ModelRef): AccountUsage | undefined =>
    spentByRefusal(provider, account, freshest(provider, account, attached), model);

// Translator subscriptions for a provider, or none if it holds no auth files for it.
const routedAccounts = (provider: AgentProvider): TranslatorAccounts[keyof TranslatorAccounts] =>
    translatorAccounts.value[provider as keyof TranslatorAccounts] ?? [];

// Same as liveUsage, for a caller holding only an account id (composer chip, picker rows, a refused-turn
// sentence) rather than a row.
export const usageStatusFor = (provider: AgentProvider, account: string | undefined, model?: ModelRef): AccountUsage | undefined =>
    account === undefined ? undefined : liveUsage(provider, account, undefined, model);

export interface PlanLimitPool {
    readonly kind: string;
    readonly label: string;
    // Rounded once here, so a meter's width and its printed number can't disagree.
    readonly percent: number;
    readonly resetsAt: number | undefined;
    // Which models this pool gates; a percentage alone can't say whether it blocks anything you run.
    readonly gates: WindowGates;
}

// One reading as its pools: named, worst-first, rounded once — the shared basis for every plan-limit display
// (meters, ring hover, screen reader).
const usagePools = (usage: AccountUsage): readonly PlanLimitPool[] =>
    orderedWindows(usage).map((window) => ({
        kind: window.kind,
        label: usageWindowLabel(window),
        percent: Math.round(window.utilization),
        resetsAt: window.resetsAt,
        gates: window.gates,
    }));

// Short label for a pool's window length (e.g. "5h", "wk"), so a narrow rail can show both allowances instead
// of a bare percent. The rule lives in the contract (windowPeriod), since the daemon retires a reading with no
// published reset by the same window length this column names it by.
export type PoolPeriod = WindowPeriod;

/** Window length behind a pool, and the short token a narrow column names it by. */
export const poolPeriod = (pool: Pick<PlanLimitPool, `kind` | `label`>): PoolPeriod | undefined => windowPeriod(pool);

// Words that name only the period, not scope; used to strip them so poolScope can find a pool's actual name.
const PERIOD_WORDS = new Set([
    `hour`,
    `hours`,
    `day`,
    `days`,
    `week`,
    `weeks`,
    `weekly`,
    `month`,
    `months`,
    `monthly`,
    `daily`,
    `session`,
    `window`,
    `windows`,
    `limit`,
    `limits`,
    `quota`,
    `usage`,
    `five`,
    `seven`,
    `twelve`,
]);

const isPeriodOnly = (part: string): boolean => {
    const words = part
        .toLowerCase()
        .split(/[^a-z0-9]+/u)
        .filter(Boolean);
    return words.length > 0 && words.every((word) => PERIOD_WORDS.has(word) || /^\d+$/u.test(word));
};

export const poolScope = (pool: Pick<PlanLimitPool, `label` | `gates`>): string | undefined => {
    if (pool.gates === `all` || pool.gates === `none`) {
        return undefined;
    }
    const named = pool.label
        .split(`·`)
        .map((part) => part.trim())
        .find((part) => part !== `` && !isPeriodOnly(part));
    return (named ?? pool.gates.models.join(`, `)).replace(/\s+models?$/iu, ``);
};

// Which pool a model draws on: one pool per model when a plan meters them separately (plan-pools.ts decides which).

// One model's own pool, as much as the plan publishes: its figures plus the plan's name for it (e.g. "Opus"),
// for building a sentence about it.
export interface ModelAllowance {
    readonly name: string;
    readonly percent: number;
    readonly resetsAt: number | undefined;
}

// The model's own pool, or undefined when the plan doesn't meter it separately, or nothing has been read yet.
// An ambiguous match answers nothing too — no sentence beats a wrong one.
export const modelAllowance = (usage: AccountUsage | undefined, model: ModelRef): ModelAllowance | undefined => {
    const pool = scopedWindow(usage, model);
    if (pool === undefined) {
        return undefined;
    }
    // Plan's own pool name when given, else the kind with its scope prefix stripped.
    return { name: pool.label ?? pool.kind.replace(/^model:/u, ``), percent: Math.round(pool.utilization), resetsAt: pool.resetsAt };
};

// Binding pool, matched by kind among the already-rounded pools, so a headline number and its named pool
// never disagree.
const bindingPool = (usage: AccountUsage, pools: readonly PlanLimitPool[], model: ModelRef | undefined): PlanLimitPool | undefined => {
    const window = bindingWindow(usage, model);
    return window === undefined ? undefined : pools.find((pool) => pool.kind === window.kind);
};

export interface PlanHeadroom {
    // The binding pool's figure: what the ring draws and its tone is based on.
    readonly percent: number;
    readonly tone: string;
    readonly stale: boolean;
    readonly measuredAt: number;
    // Set while re-reading this account keeps failing: `measuredAt` then stops moving until someone acts or it clears.
    readonly unread: UsageUnread | undefined;
    readonly pools: readonly PlanLimitPool[];
    // Pool `percent` came from; undefined only when every pool has reset (measured, nothing left to name).
    readonly binding: PlanLimitPool | undefined;
}

// An account's headroom, projected once: the ring's number and tone, plus the per-pool breakdown for the card
// behind it. Undefined only with no reading at all; a reset account still reads 0%, unlike usagePercent's undefined.
export const planHeadroom = (usage: AccountUsage | undefined, model?: ModelRef): PlanHeadroom | undefined => {
    if (usage === undefined) {
        return undefined;
    }
    const pools = usagePools(usage);
    const binding = bindingPool(usage, pools, model);
    const percent = binding?.percent ?? 0;
    return { percent, tone: usageTone(percent), stale: isStale(usage), measuredAt: usage.measuredAt, unread: usage.unread, pools, binding };
};

// Epoch-seconds reset instant as a short local label: a weekday + time inside the coming week ("Mon 15:20"), the date
// beyond it ("Oct 20, 11:59"), since a monthly pool's weekday reads as two days away. No ticking relative clock.
export const formatReset = (epochSeconds: number, now: number = Date.now()): string => formatWhen(epochSeconds * 1000, now);

// Relative wait, where a wall-clock time forces arithmetic a reader shouldn't need. Deliberately coarse ("about"), not
// a live countdown — polling has its own jitter. Carries units all the way up: a wait stated in minutes stops being
// readable somewhere around the hour ("about 244 min" is four hours nobody should have to divide), and a spent weekly
// allowance is days out, not minutes.
export const formatWait = (epochSeconds: number, now: number = Date.now()): string => {
    const seconds = Math.max(0, Math.round((epochSeconds * 1000 - now) / 1000));
    if (seconds < 90) {
        return `about ${Math.max(5, Math.round(seconds / 5) * 5)}s`;
    }
    const minutes = Math.round(seconds / 60);
    if (minutes < 90) {
        return `about ${minutes} min`;
    }
    const hours = seconds / 3_600;
    // One decimal under ten hours, so 4h and 4.5h are different sentences; whole hours past that, where the half no
    // longer changes what anyone does.
    if (hours < 36) {
        return `about ${hours < 10 ? Math.round(hours * 2) / 2 : Math.round(hours)}h`;
    }
    return `about ${Math.round(hours / 24)} days`;
};

// Age of a reading in the kit's day-based words, not an absolute date, so staleness reads the same at any
// distance. Taken at a turn's end, and utilization only climbs, so the number is a floor.
export const formatAge = (measuredAt: number, now: number = Date.now()): string => timeAgo(measuredAt, { now, days: true });

// The age a header may print over a set of readings: the oldest one a re-read can still move. A reading whose re-read
// keeps failing is left out whatever stopped it (UsageUnread), since its age only grows and would date every fresh
// reading beside it; the caller names those instead (unreadGroups). One rule for every header, keyed on the fact that
// the read failed rather than on a list of known reasons, so a provider's next new way to refuse a read cannot pin it.
// When nothing can move, the oldest there is: every number is stuck, and the header must say how old they are.
export const oldestMovableReading = (
    readings: readonly { readonly measuredAt: number | undefined; readonly unread: UsageUnread | undefined }[],
): number | undefined => {
    const taken = readings.flatMap((reading) => (reading.measuredAt === undefined ? [] : [reading]));
    const movable = taken.filter((reading) => reading.unread === undefined);
    const ages = (movable.length > 0 ? movable : taken).flatMap((reading) => (reading.measuredAt === undefined ? [] : [reading.measuredAt]));
    return ages.length === 0 ? undefined : Math.min(...ages);
};

// Past this, a reading is a floor: other clients spend the same account-wide pools unseen.
const STALE_AFTER_MS = 10 * 60_000;
export const isStale = (usage: AccountUsage, now: number = Date.now()): boolean => now - usage.measuredAt > STALE_AFTER_MS;

// An allowance is drawn as what is LEFT, a gauge that drains as turns spend it: the question every one of these surfaces
// answers is "can I keep working here", and a remaining figure answers it without subtracting. Readings stay the
// providers' utilization underneath (sorting, tone, the spent line); only what a reader sees is turned around.
export const remainingPercent = (percent: number): number => Math.min(100, Math.max(0, 100 - percent));

// A stale reading's use is a floor (other devices spend the same pools unseen), so what it leaves is a ceiling: `≤`.
// Never marks a spent pool, which has nowhere lower to fall. The bare figure is for a column whose header already says
// "Left"; everywhere else the word rides with the number, since a bare percentage of an allowance reads either way.
export const remainingFigure = (percent: number, stale: boolean): string =>
    `${stale && percent < SPENT_UTILIZATION ? `≤` : ``}${remainingPercent(percent)}%`;
export const formatRemaining = (percent: number, stale: boolean): string => t(`shared.percentLeft`, { percent: remainingFigure(percent, stale) });

// A meter's fill: what is left, with a sliver kept for a pool on its last percent so it still reads as "a little",
// not "none". A spent pool draws no fill at all; its track takes the danger tint instead (meterTrack), since an empty
// neutral track is what a missing reading looks like.
export const meterFill = (percent: number, sliver = 2): number =>
    percent >= SPENT_UTILIZATION ? 0 : Math.max(remainingPercent(percent), sliver);
export const meterTrack = (percent: number): string => (percent >= SPENT_UTILIZATION ? `bg-danger/25` : `bg-content/10`);

// A draining meter changes colour as it empties, the way a battery does: green while there is plenty, turning through
// amber to the danger red a spent pool wears, so "full" and "nearly out" are seen before they are read. It holds green
// down to half, since plenty is not news and a ramp over the whole range would give every bar its own in-between hue;
// below that it moves, reaching amber at a fifth left and red only at the very end, so tight and spent never share a
// colour. The stops are the status roles, not the brand accent, which in some looks already sits between them.
// Returned as the element's `color`, so the figure and the fill (ui-meter-fill paints from currentColor) change
// together. Colour only reinforces: length and figure carry the reading, since the ramp is lost on a red-weak reader.
const GREEN_DOWN_TO = 50;
const AMBER_AT = 20;
const mixed = (toward: string, from: string, share: number): string =>
    `color-mix(in oklch, var(--color-${toward}) ${Math.round(100 * share)}%, var(--color-${from}))`;
export const meterTint = (percent: number): { color?: string } => {
    const left = remainingPercent(percent);
    if (left >= GREEN_DOWN_TO) {
        return {};
    }
    return {
        color:
            left >= AMBER_AT
                ? mixed(`warning`, `success`, (GREEN_DOWN_TO - left) / (GREEN_DOWN_TO - AMBER_AT))
                : mixed(`danger`, `warning`, (AMBER_AT - left) / AMBER_AT),
    };
};

// Same breakdown as one sentence: the ring's accessible name, since a screen reader has no hover to reach the
// card. Lists every pool (a single number can't say which is binding), reset in parens.
export const usageDetail = (headroom: PlanHeadroom): string =>
    [
        ...headroom.pools.map(
            (pool) =>
                `${pool.label} ${formatRemaining(pool.percent, headroom.stale)}${pool.resetsAt === undefined ? `` : ` (resets ${formatReset(pool.resetsAt)})`}`,
        ),
        `measured ${formatAge(headroom.measuredAt)}`,
    ].join(` · `);

// Every connection this sandbox holds — a provider's own account and a routed subscription alike — as one row
// shape, shared with the Agent tab's rings. An account with no reading is still a row, distinct from one with room.

export interface PlanLimitRow {
    // Unique across providers; a routed account's own id is only unique within its provider.
    readonly id: string;
    readonly provider: AgentProvider;
    // Daemon's own key for this account (id or auth-file name); what a refusal names to identify it.
    readonly account: string;
    readonly label: string;
    // Who this signs in as, when the (renameable) label doesn't already say it.
    readonly identity: string | undefined;
    // Undefined ⇒ no reading at all; `readable` then says whether one is even obtainable.
    readonly percent: number | undefined;
    readonly pools: readonly PlanLimitPool[];
    // Pool the percent came from, the one gating this account's next turn; carried, not re-derived.
    readonly binding: PlanLimitPool | undefined;
    readonly measuredAt: number | undefined;
    // Re-reading this account keeps failing, and why; `measuredAt` is then the last read that succeeded.
    readonly unread: UsageUnread | undefined;
    readonly stale: boolean;
    readonly readable: boolean;
    // Pickable by name (native) or balanced automatically (routed); provider alone can't tell — Grok is both.
    readonly routed: boolean;
    // Whether it can serve a turn (accountState): every band, group, count and fix on a headroom surface reads this.
    readonly state: AccountState;
    // What the verdict was judged from, as the wire carried it with the freshest reading: what a refusal is read against.
    readonly facts: ServiceFacts;
}

// An account row as the daemon sends it, whichever list it came in.
export type AccountFacts = ServiceFacts & { readonly state?: AccountState | undefined };

/** A provider's own account row, as the serviceability rule reads it. */
export const accountFacts = (account: OauthAccount): AccountFacts => ({
    account: account.id,
    needsReauth: account.needsReauth,
    detail: account.detail,
    seatRefusal: account.seatRefusal,
    usage: account.usage,
    state: account.state,
});

/** A routed credential, as the serviceability rule reads it. */
export const routedAccountFacts = (account: TranslatorAccounts[keyof TranslatorAccounts][number]): AccountFacts => ({
    account: account.name,
    usage: account.usage,
    cooling: account.cooling,
    state: account.state,
});

// Every connection a provider holds (native and routed are one list to the reader), each with its freshest raw
// reading: never corrected by spentByRefusal, since judging a refusal on corrected data would let a pinned 100% feed
// itself forever.
const providerFacts = (provider: AgentProvider): readonly AccountFacts[] =>
    [...(providerAccounts.value[provider] ?? []).map(accountFacts), ...routedAccounts(provider).map(routedAccountFacts)].map((facts) => ({
        ...facts,
        usage: freshest(provider, facts.account, facts.usage),
    }));

// FALLBACK for a daemon older than `AccountState`: the contract's own rule (the one the daemon runs) over the fields
// that daemon did send. Delete once no supported daemon lacks `state`.
const legacyState = (provider: AgentProvider, facts: AccountFacts, now: number): AccountState => {
    // The row's own facts first: the lists a caller holds can be newer than the module's copy.
    const own = { ...facts, usage: freshest(provider, facts.account, facts.usage) };
    const judged = [own, ...providerFacts(provider).filter((entry) => entry.account !== facts.account)];
    return serviceStates(judged, providerRefusals.value[provider], undefined, now).get(facts.account) ?? { kind: `unknown` };
};

// A bench whose instant has passed has lifted, whatever the list that reported it said.
const stillBlocked = (state: AccountState, now: number): boolean =>
    state.kind === `blocked` && (state.fix !== `wait` || state.until === undefined || state.until * 1000 > now);

/**
 * Whether an account can serve a turn: the daemon's verdict (`state`), read as it stands for what only the account list
 * carries (a revoked sign-in, a lost seat, a bench, a refusal). The plan-limit half is re-read on the live reading when
 * there is one, by the contract's one rule (`headroomState`), since readings and limit refusals stream in between lists,
 * and a question about one model asks about the pools that model spends.
 */
export const accountState = (provider: AgentProvider, facts: AccountFacts, model?: ModelRef, now: number = Date.now()): AccountState => {
    const verdict = facts.state ?? legacyState(provider, facts, now);
    if (stillBlocked(verdict, now)) {
        return verdict;
    }
    const live = liveUsage(provider, facts.account, facts.usage, model);
    return live === undefined && verdict.kind !== `blocked` ? verdict : headroomState(live, model);
};

// Common shape a row is built from: the daemon's facts, its label/identity. Named fields, not positionals — label and
// identity are both strings and easy to swap by accident.
interface PlanLimitSource {
    readonly facts: AccountFacts;
    readonly label: string;
    readonly identity: string | undefined;
    readonly routed: boolean;
}

const planLimitRow = (provider: AgentProvider, source: PlanLimitSource, now: number): PlanLimitRow => {
    const { account } = source.facts;
    const usage = liveUsage(provider, account, source.facts.usage);
    const pools = usage === undefined ? [] : usagePools(usage);
    const binding = usage === undefined ? undefined : bindingPool(usage, pools, undefined);
    return {
        id: `${provider}:${account}`,
        provider,
        account,
        label: source.label,
        identity: source.identity,
        percent: binding?.percent,
        pools,
        binding,
        measuredAt: usage?.measuredAt,
        unread: usage?.unread,
        stale: usage !== undefined && isStale(usage),
        readable: reportsPlanLimits(provider),
        routed: source.routed,
        state: accountState(provider, source.facts, undefined, now),
        facts: { ...source.facts, usage: freshest(provider, account, source.facts.usage) },
    };
};

// Measured rows first, tightest on top — the account about to gate a turn should be visible without scrolling.
// Unmeasured rows sink; unknown isn't headroom.
export const planLimitRows = (native: Record<string, readonly OauthAccount[]>, routed: TranslatorAccounts, now: number = Date.now()): PlanLimitRow[] =>
    [
        ...Object.entries(native).flatMap(([provider, accounts]) =>
            accounts.map((account) =>
                planLimitRow(provider, {
                    facts: accountFacts(account),
                    label: account.label,
                    // Omitted when it would just repeat the label (already the account's email).
                    identity: account.email === account.label ? undefined : account.email,
                    routed: false,
                }, now),
            ),
        ),
        // Routed accounts have no separate identity (label is the name).
        ...Object.entries(routed).flatMap(([provider, accounts]) =>
            accounts.map((account) => planLimitRow(provider, { facts: routedAccountFacts(account), label: account.label, identity: undefined, routed: true }, now)),
        ),
    ].toSorted((left, right) => {
        if (left.percent === undefined || right.percent === undefined) {
            return left.percent === right.percent ? left.label.localeCompare(right.label) : left.percent === undefined ? 1 : -1;
        }
        return right.percent - left.percent || left.label.localeCompare(right.label);
    });

// Aggregated by provider: rows don't scale to dozens of accounts, so capacity is a band count, not an average.

// Worst-first order, shared by the bar, legend and sentence so none disagree about which end is bad.
export const PLAN_LIMIT_BANDS = [`blocked`, `spent`, `tight`, `room`, `unread`, `none`] as const;
export type PlanLimitBand = (typeof PLAN_LIMIT_BANDS)[number];

// Straight off the verdict. `blocked` and `none` aren't fullness levels — one can serve nothing whatever its meters
// say, the other publishes no meters at all — so both are counted beside the capacity bar rather than inside it. A
// bench that lifts by itself is waited out like a spent pool, so it counts as one.
export const planLimitBand = (row: Pick<PlanLimitRow, `state` | `readable`>): PlanLimitBand => {
    switch (row.state.kind) {
        case `blocked`:
            return row.state.fix === `wait` ? `spent` : `blocked`;
        case `spent`:
            return `spent`;
        case `ready`:
            return SPENT_UTILIZATION - row.state.room >= TIGHT_PERCENT ? `tight` : `room`;
        case `unknown`:
            return row.readable ? `unread` : `none`;
    }
};

// Sentence fragments, not headings — read as "3 with room · 1 tight". Built when read, in the reader's language.
export const planLimitBandLabel = (band: PlanLimitBand): string => {
    switch (band) {
        case `blocked`:
            return t(`chat.planLimitBand.blocked`);
        case `spent`:
            return t(`chat.planLimitBand.spent`);
        case `tight`:
            return t(`chat.planLimitBand.tight`);
        case `room`:
            return t(`chat.planLimitBand.room`);
        case `unread`:
            return t(`chat.planLimitBand.unread`);
        case `none`:
            return t(`chat.planLimitBand.none`);
    }
};

// Same three tones a percentage uses everywhere, so the bar and its meters agree. `unread`/`none` are
// achromatic on purpose: absence of a reading, not a severity.
export const planLimitBandTone = (band: PlanLimitBand): string =>
    band === `spent` || band === `blocked` ? `text-danger` : band === `tight` ? `text-warning` : band === `room` ? `text-success` : `text-muted`;
// The tight band drawn in the colour a tight account's own bar wears (meterTint, mid-band), since beside `room` the
// warning tone alone is near-identical in some looks.
const TIGHT_LEFT_MID = 10;
export const planLimitBandTint = (band: PlanLimitBand): { color?: string } => (band === `tight` ? meterTint(100 - TIGHT_LEFT_MID) : {});

export type PlanLimitCounts = Record<PlanLimitBand, number>;

const countBands = (rows: readonly PlanLimitRow[]): PlanLimitCounts => {
    const counts: PlanLimitCounts = { blocked: 0, spent: 0, tight: 0, room: 0, unread: 0, none: 0 };
    for (const row of rows) {
        counts[planLimitBand(row)] += 1;
    }
    return counts;
};

// Soonest pool reopening, in epoch seconds; past resets are ignored — that pool has already reopened.
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
    // Account gating this provider first; what the group row states instead of its own percentage.
    readonly tightest: PlanLimitRow | undefined;
    readonly nextResetAt: number | undefined;
    // Last refusal for this provider, already read against what's happened since (refusalNote).
    readonly refusal: RefusalNote | undefined;
    // Account the refusal named, if still connected; only for placement, not for deciding whether it's answered.
    readonly refusedRow: PlanLimitRow | undefined;
}

// One group per provider, most-constrained account first, groups ordered the same way — closest to gating a
// turn first, unread providers sink.
export const planLimitGroups = (
    rows: readonly PlanLimitRow[],
    refusals: Record<string, ProviderRefusal> = {},
    now: number = Date.now(),
): PlanLimitGroup[] => {
    const byProvider = new Map<AgentProvider, PlanLimitRow[]>();
    for (const row of rows) {
        const group = byProvider.get(row.provider) ?? [];
        group.push(row);
        byProvider.set(row.provider, group);
    }
    return [...byProvider.entries()]
        .map(([provider, groupRows]): PlanLimitGroup => {
            const tightest = groupRows.find((row) => row.percent !== undefined);
            const refusal = refusals[provider];
            return {
                provider,
                rows: groupRows,
                counts: countBands(groupRows),
                tightest,
                nextResetAt: nextReset(groupRows, now),
                refusal: refusalNote(
                    refusal,
                    groupRows.map((row) => row.facts),
                    now,
                ),
                refusedRow: groupRows.find((row) => row.account === refusal?.account),
            };
        })
        .toSorted((left, right) => (right.tightest?.percent ?? -1) - (left.tightest?.percent ?? -1) || left.provider.localeCompare(right.provider));
};

// Provider's own words, quoted while current; once answered they move to `detail` as a footnote.
const REFUSAL_CONDITION: Record<ProviderRefusal["kind"], string> = {
    limit: `Hit its usage limit`,
    auth: `Refused its credential`,
    // Not "refused its credential": the credential is fine, the plan turned the account away.
    entitlement: `Turned this account away`,
};
const REFUSAL_ANSWERED: Record<ProviderRefusal["kind"], string> = {
    limit: `has had room since`,
    auth: `authenticated fine since`,
    entitlement: `has run a turn since`,
};

export interface RefusalNote {
    // Provider's own sentence while current; what's happened since once it's answered.
    readonly line: string;
    // Provider's own words in both states; the hover once `line` stops printing them.
    readonly detail: string;
    // Alarm vs footnote; never hidden either way, just less urgent once answered.
    readonly current: boolean;
}

// Whether the refusal is over is the contract's call (refusalVerdict, the one the daemon judges by); this only says it.
export const refusalNote = (refusal: ProviderRefusal | undefined, accounts: readonly ServiceFacts[], now: number = Date.now()): RefusalNote | undefined => {
    if (refusal === undefined) {
        return undefined;
    }
    const verdict = refusalVerdict(refusal, accounts);
    const answer = verdict === `gone` ? `that account is no longer connected` : verdict === `answered` ? REFUSAL_ANSWERED[refusal.kind] : undefined;
    const opening = `${REFUSAL_CONDITION[refusal.kind]} ${formatAge(refusal.at, now)}`;
    return {
        line: answer === undefined ? `${opening}, ${refusal.message}` : `${opening}, ${answer}.`,
        detail: refusal.message,
        current: answer === undefined,
    };
};

// Provider's refusal read against everything since, for a caller holding only the provider. Same verdict
// spentByRefusal pins a pool on, and the composer footer and Agent tab both print.
export const refusalFor = (provider: AgentProvider, now: number = Date.now()): RefusalNote | undefined =>
    refusalNote(providerRefusals.value[provider], providerFacts(provider), now);

// Whether a `limit` refusal still stands for this account: must be a limit refusal, must name this account or
// none (then it covers every connection), and must be unanswered by a since reading with room.
const limitStandsFor = (provider: AgentProvider, account: string, reading: AccountUsage | undefined): boolean => {
    const refusal = providerRefusals.value[provider];
    if (refusal === undefined || refusal.kind !== `limit` || (refusal.account !== undefined && refusal.account !== account)) {
        return false;
    }
    // This account's fresher reading goes first, ahead of any stale copy.
    const accounts = [{ account, usage: reading }, ...providerFacts(provider).filter((entry) => entry.account !== account)];
    return refusalVerdict(refusal, accounts) === `standing`;
};

// Readings that stopped moving, grouped by the provider's reason: four accounts Google wants verified are one sentence,
// not four. Each group carries its own oldest age, the one its numbers are as old as.
export interface PlanLimitUnread {
    readonly reason: string;
    readonly rows: readonly PlanLimitRow[];
    // The oldest last-successful read among them, what their numbers are as old as.
    readonly lastReadAt: number | undefined;
}

// Most accounts first, like attentionGroups.
export const unreadGroups = (rows: readonly PlanLimitRow[]): PlanLimitUnread[] => {
    const byReason = new Map<string, PlanLimitRow[]>();
    for (const row of rows) {
        if (row.unread !== undefined) {
            byReason.set(row.unread.reason, [...(byReason.get(row.unread.reason) ?? []), row]);
        }
    }
    return [...byReason]
        .map(([reason, grouped]): PlanLimitUnread => {
            const ages = grouped.flatMap((row) => (row.measuredAt === undefined ? [] : [row.measuredAt]));
            return { reason, rows: grouped, lastReadAt: ages.length === 0 ? undefined : Math.min(...ages) };
        })
        .toSorted((left, right) => right.rows.length - left.rows.length || left.reason.localeCompare(right.reason));
};

/** What a blocked account is waiting on, by who can fix it: the heading a group of them is named by, in the reader's language. */
export const accountFixLabel = (fix: AccountFix): string => {
    switch (fix) {
        case `reconnect`:
            return t(`chat.accountFix.reconnect`);
        case `admin`:
            return t(`chat.accountFix.admin`);
        case `wait`:
            return t(`chat.accountFix.wait`);
    }
};

// Accounts held back until a person acts, grouped by who that is, since the instruction belongs to the fix and not to
// each name: thirty expired sign-ins are one instruction, not thirty. Each row's own reason stays on the row. A bench
// that lifts by itself (`wait`) needs nobody, so it is not here.
export interface PlanLimitAttention {
    readonly fix: AccountFix;
    readonly rows: readonly (PlanLimitRow & { readonly state: Extract<AccountState, { kind: `blocked` }> })[];
    // Their reasons, each once, in row order: what the provider said, beside the fix's own name.
    readonly reasons: readonly string[];
}

const FIX_ORDER: readonly AccountFix[] = [`reconnect`, `admin`];

// Most accounts first, so the condition holding the most of the fleet back leads.
export const attentionGroups = (rows: readonly PlanLimitRow[]): PlanLimitAttention[] =>
    FIX_ORDER.map((fix) => {
        const held = rows.flatMap((row) => (row.state.kind === `blocked` && row.state.fix === fix ? [{ ...row, state: row.state }] : []));
        return { fix, rows: held, reasons: [...new Set(held.map((row) => row.state.reason))] };
    })
        .filter((group) => group.rows.length > 0)
        .toSorted((left, right) => right.rows.length - left.rows.length);

export interface PlanLimitSummary {
    readonly accounts: number;
    readonly counts: PlanLimitCounts;
    readonly nextResetAt: number | undefined;
    // Accounts needing manual action only; a spent pool isn't broken, it already refills on its own schedule.
    readonly attention: readonly PlanLimitAttention[];
}

export const planLimitSummary = (rows: readonly PlanLimitRow[], now: number = Date.now()): PlanLimitSummary => ({
    accounts: rows.length,
    counts: countBands(rows),
    nextResetAt: nextReset(rows, now),
    attention: attentionGroups(rows),
});
