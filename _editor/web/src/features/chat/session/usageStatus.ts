import {
    type AccountUsage,
    type AgentProvider,
    bindingWindow,
    type ModelRef,
    type OauthAccount,
    type ProviderRefusal,
    reportsPlanLimits,
    scopedWindow,
    type TranslatorAccounts,
    type UsageWindow,
    type WindowGates,
} from "@intentic/sandbox-contract";
import { formatWeekdayTime, timeAgo } from "@intentic/ui/format";
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

// Severity shared by every surface that draws a percentage, so it means the same thing everywhere. Danger
// is reserved for an effectively spent pool.
export const usageTone = (percent: number): string =>
    percent >= SPENT_PERCENT ? `text-danger` : percent >= TIGHT_PERCENT ? `text-warning` : `text-link`;

// Named thresholds so every surface (dimming, ring colour, capacity bands) agrees on spent vs tight.
export const SPENT_PERCENT = 90;
const TIGHT_PERCENT = 75;
export const isSpent = (usage: AccountUsage | undefined, model?: ModelRef): boolean => {
    const percent = usagePercent(usage, model);
    return percent !== undefined && percent >= SPENT_PERCENT;
};

// Same threshold, inverted: room means below SPENT_PERCENT. Shared with answersRefusal's judgement.
const hasRoom = (percent: number | undefined): boolean => percent !== undefined && percent < SPENT_PERCENT;

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
    if (usage === undefined || binding === undefined || binding.utilization >= 100 || !limitStandsFor(provider, account, usage)) {
        return usage;
    }
    return { ...usage, windows: usage.windows.map((entry) => (entry === binding ? { ...entry, utilization: 100 } : entry)) };
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
// of a bare percent. Read off the provider's own kind/label words; `seconds` orders windows soonest-first.
export interface PoolPeriod {
    readonly seconds: number;
    readonly short: string;
}

const HOUR_SECONDS = 3_600;
const DAY_SECONDS = 86_400;

// Kind and label as space-padded lowercase words, underscores split, so `\b` matches across both spellings.
const poolWords = (pool: Pick<PlanLimitPool, `kind` | `label`>): string =>
    ` ${`${pool.kind} ${pool.label}`
        .toLowerCase()
        .replaceAll(/[^a-z0-9]+/gu, ` `)
        .trim()} `;

/**
 * Window length behind a pool, and the short token a narrow column names it by. Undefined when the provider's
 * period text isn't recognised; caller falls back to the pool's own label.
 */
export const poolPeriod = (pool: Pick<PlanLimitPool, `kind` | `label`>): PoolPeriod | undefined => {
    const words = poolWords(pool);
    const hours = /\b(\d+) hours?\b/u.exec(words)?.[1];
    const days = /\b(\d+) days?\b/u.exec(words)?.[1];
    if (/\bfive hours?\b/u.test(words) || hours === `5`) {
        return { seconds: 5 * HOUR_SECONDS, short: `5h` };
    }
    if (hours !== undefined) {
        return { seconds: Number(hours) * HOUR_SECONDS, short: `${hours}h` };
    }
    if (/\bseven days?\b/u.test(words) || days === `7` || /\bweek(ly|s)?\b/u.test(words)) {
        return { seconds: 7 * DAY_SECONDS, short: `wk` };
    }
    if (/\bmonth(ly|s)?\b/u.test(words)) {
        return { seconds: 30 * DAY_SECONDS, short: `mo` };
    }
    if (/\bdaily\b/u.test(words) || days === `1`) {
        return { seconds: DAY_SECONDS, short: `24h` };
    }
    if (days !== undefined) {
        return { seconds: Number(days) * DAY_SECONDS, short: `${days}d` };
    }
    const minutes = /\b(\d+) minutes?\b/u.exec(words)?.[1];
    return minutes === undefined ? undefined : { seconds: Number(minutes) * 60, short: `${minutes}m` };
};

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
    return { percent, tone: usageTone(percent), stale: isStale(usage), measuredAt: usage.measuredAt, pools, binding };
};

// Epoch-seconds reset instant as a short local weekday + time (e.g. "Mon 15:20"); no ticking relative clock.
export const formatReset = (epochSeconds: number): string => formatWeekdayTime(epochSeconds * 1000);

// Relative wait for an outage retry (seconds to minutes out), where a wall-clock time forces arithmetic a
// reader shouldn't need. Deliberately coarse ("about"), not a live countdown — polling has its own jitter.
export const formatWait = (epochSeconds: number, now: number = Date.now()): string => {
    const seconds = Math.max(0, Math.round((epochSeconds * 1000 - now) / 1000));
    if (seconds < 90) {
        return `about ${Math.max(5, Math.round(seconds / 5) * 5)}s`;
    }
    return `about ${Math.round(seconds / 60)} min`;
};

// Age of a reading in the kit's day-based words, not an absolute date, so staleness reads the same at any
// distance. Taken at a turn's end, and utilization only climbs, so the number is a floor.
export const formatAge = (measuredAt: number, now: number = Date.now()): string => timeAgo(measuredAt, { now, days: true });

// Past this, a reading is a floor: other clients spend the same account-wide pools unseen.
const STALE_AFTER_MS = 10 * 60_000;
export const isStale = (usage: AccountUsage, now: number = Date.now()): boolean => now - usage.measuredAt > STALE_AFTER_MS;

// Marks a percentage as a floor when the reading is stale enough to have been overtaken. Never marks 100:
// a full pool has nowhere left to climb to.
export const formatUtilization = (percent: number, stale: boolean): string => `${stale && percent < 100 ? `≥` : ``}${percent}%`;

// Same breakdown as one sentence: the ring's accessible name, since a screen reader has no hover to reach the
// card. Lists every pool (a single number can't say which is binding), reset in parens.
export const usageDetail = (headroom: PlanHeadroom): string =>
    [
        ...headroom.pools.map(
            (pool) =>
                `${pool.label} ${formatUtilization(pool.percent, headroom.stale)}${pool.resetsAt === undefined ? `` : ` (resets ${formatReset(pool.resetsAt)})`}`,
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
    readonly stale: boolean;
    readonly readable: boolean;
    // Credential can no longer be refreshed; unrelated to headroom, decides whether it can serve a turn.
    readonly needsReauth: boolean;
    // Pickable by name (native) or balanced automatically (routed); provider alone can't tell — Grok is both.
    readonly routed: boolean;
    // Translator routes around this credential now, regardless of its last reading; undefined means in rotation.
    readonly cooling: { readonly until?: number | undefined; readonly reason?: string | undefined } | undefined;
}

// Common shape a row is built from: the daemon's account key, its label/identity, and the reading attached.
// Named fields, not positionals — label and identity are both strings and easy to swap by accident.
interface PlanLimitSource {
    readonly account: string;
    readonly label: string;
    readonly identity: string | undefined;
    readonly attached: AccountUsage | undefined;
    readonly needsReauth: boolean;
    readonly routed: boolean;
    readonly cooling: PlanLimitRow["cooling"];
}

const planLimitRow = (provider: AgentProvider, source: PlanLimitSource): PlanLimitRow => {
    const usage = liveUsage(provider, source.account, source.attached);
    const pools = usage === undefined ? [] : usagePools(usage);
    const binding = usage === undefined ? undefined : bindingPool(usage, pools, undefined);
    return {
        id: `${provider}:${source.account}`,
        provider,
        account: source.account,
        label: source.label,
        identity: source.identity,
        percent: binding?.percent,
        pools,
        binding,
        measuredAt: usage?.measuredAt,
        stale: usage !== undefined && isStale(usage),
        readable: reportsPlanLimits(provider),
        needsReauth: source.needsReauth,
        routed: source.routed,
        cooling: source.cooling,
    };
};

// Measured rows first, tightest on top — the account about to gate a turn should be visible without scrolling.
// Unmeasured rows sink; unknown isn't headroom.
export const planLimitRows = (native: Record<string, readonly OauthAccount[]>, routed: TranslatorAccounts): PlanLimitRow[] =>
    [
        ...Object.entries(native).flatMap(([provider, accounts]) =>
            accounts.map((account) =>
                planLimitRow(provider, {
                    account: account.id,
                    label: account.label,
                    // Omitted when it would just repeat the label (already the account's email).
                    identity: account.email === account.label ? undefined : account.email,
                    attached: account.usage,
                    needsReauth: account.needsReauth === true,
                    routed: false,
                    cooling: undefined,
                }),
            ),
        ),
        // Routed accounts have no reauth flag (broken ones are dropped) and no separate identity (label is the name).
        ...Object.entries(routed).flatMap(([provider, accounts]) =>
            accounts.map((account) =>
                planLimitRow(provider, {
                    account: account.name,
                    label: account.label,
                    identity: undefined,
                    attached: account.usage,
                    needsReauth: false,
                    routed: true,
                    cooling: account.cooling,
                }),
            ),
        ),
    ].toSorted((left, right) => {
        if (left.percent === undefined || right.percent === undefined) {
            return left.percent === right.percent ? left.label.localeCompare(right.label) : left.percent === undefined ? 1 : -1;
        }
        return right.percent - left.percent || left.label.localeCompare(right.label);
    });

// Aggregated by provider: rows don't scale to dozens of accounts, so capacity is a band count, not an average.

// Worst-first order, shared by the bar, legend and sentence so none disagree about which end is bad.
export const PLAN_LIMIT_BANDS = [`spent`, `tight`, `room`, `unread`, `none`] as const;
export type PlanLimitBand = (typeof PLAN_LIMIT_BANDS)[number];

// `none` isn't a fullness level, it's a plan that publishes no limits at all — kept out of the capacity bar
// since unknowable headroom isn't headroom. Takes just the two fields it needs so a picker can band rings it
// already has.
export const planLimitBand = (row: Pick<PlanLimitRow, `percent` | `readable`>): PlanLimitBand => {
    if (row.percent === undefined) {
        return row.readable ? `unread` : `none`;
    }
    return row.percent >= SPENT_PERCENT ? `spent` : row.percent >= TIGHT_PERCENT ? `tight` : `room`;
};

// Sentence fragments, not headings — read as "3 with room · 1 tight".
export const PLAN_LIMIT_BAND_LABEL: Record<PlanLimitBand, string> = {
    spent: `spent`,
    tight: `tight`,
    room: `with room`,
    unread: `unread`,
    none: `no published limits`,
};

// Same three tones a percentage uses everywhere, so the bar and its meters agree. `unread`/`none` are
// achromatic on purpose: absence of a reading, not a severity.
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
                refusal: refusalNote(refusal, groupRows, now),
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

// An account's state, as much as a refusal can be judged against. Shaped like PlanLimitRow so the Usage tab
// passes rows straight in.
export interface RefusalReading {
    readonly account: string;
    readonly measuredAt: number | undefined;
    readonly percent: number | undefined;
    readonly needsReauth: boolean;
}

// Whether a refusal is over, which differs by kind: a spent pool needs a reading with headroom; a rejected
// credential needs any reading since (proof the token still works).
const answersRefusal = (refusal: ProviderRefusal, reading: RefusalReading): boolean => {
    // Entitlement can't be answered by a reading — a blocked account still authenticates and reads fine.
    if (refusal.kind === `entitlement`) {
        return false;
    }
    if (reading.measuredAt === undefined || reading.measuredAt <= refusal.at) {
        return false;
    }
    return refusal.kind === `auth` ? !reading.needsReauth : hasRoom(reading.percent);
};

// Only the named account's later readings answer a refusal (others prove nothing); disconnected settles it,
// not-yet-loaded keeps it standing. An unnamed refusal is judged against the whole list.
const refusalAnswer = (refusal: ProviderRefusal, readings: readonly RefusalReading[]): string | undefined => {
    const named = readings.filter((reading) => reading.account === refusal.account);
    if (refusal.account !== undefined && named.length === 0) {
        return readings.length === 0 ? undefined : `that account is no longer connected`;
    }
    const speaking = refusal.account === undefined ? readings : named;
    return speaking.some((reading) => answersRefusal(refusal, reading)) ? REFUSAL_ANSWERED[refusal.kind] : undefined;
};

export const refusalNote = (
    refusal: ProviderRefusal | undefined,
    readings: readonly RefusalReading[],
    now: number = Date.now(),
): RefusalNote | undefined => {
    if (refusal === undefined) {
        return undefined;
    }
    const answer = refusalAnswer(refusal, readings);
    const opening = `${REFUSAL_CONDITION[refusal.kind]} ${formatAge(refusal.at, now)}`;
    return {
        line: answer === undefined ? `${opening}, ${refusal.message}` : `${opening}, ${answer}.`,
        detail: refusal.message,
        current: answer === undefined,
    };
};

// Both lists (native + routed): a provider's connections are one list to the reader. Raw, uncorrected by
// spentByRefusal — judging on corrected data would let a pinned 100% feed itself forever.
const rawReading = (provider: AgentProvider, account: string, attached: AccountUsage | undefined): Pick<RefusalReading, `measuredAt` | `percent`> => {
    const raw = freshest(provider, account, attached);
    return { measuredAt: raw?.measuredAt, percent: usagePercent(raw) };
};

const providerReadings = (provider: AgentProvider): readonly RefusalReading[] => [
    ...(providerAccounts.value[provider] ?? []).map((entry) => ({
        account: entry.id,
        ...rawReading(provider, entry.id, entry.usage),
        needsReauth: entry.needsReauth === true,
    })),
    // Routed accounts have no reauth flag; CLIProxyAPI drops an unrefreshable file instead of leaving it broken.
    ...routedAccounts(provider).map((entry) => ({ account: entry.name, ...rawReading(provider, entry.name, entry.usage), needsReauth: false })),
];

// Provider's refusal read against everything since, for a caller holding only the provider. Same verdict
// spentByRefusal pins a pool on, and the composer footer and Agent tab both print.
export const refusalFor = (provider: AgentProvider, now: number = Date.now()): RefusalNote | undefined =>
    refusalNote(providerRefusals.value[provider], providerReadings(provider), now);

// Whether a `limit` refusal still stands for this account: must be a limit refusal, must name this account or
// none (then it covers every connection), and must be unanswered by a since reading with room.
const limitStandsFor = (provider: AgentProvider, account: string, reading: AccountUsage | undefined): boolean => {
    const refusal = providerRefusals.value[provider];
    if (refusal === undefined || refusal.kind !== `limit` || (refusal.account !== undefined && refusal.account !== account)) {
        return false;
    }
    // This account's fresher reading goes first, ahead of any stale copy; needsReauth is unused for a limit refusal.
    const readings = [
        { account, measuredAt: reading?.measuredAt, percent: usagePercent(reading), needsReauth: false },
        ...providerReadings(provider).filter((entry) => entry.account !== account),
    ];
    return refusalAnswer(refusal, readings) === undefined;
};

export interface PlanLimitSummary {
    readonly accounts: number;
    readonly counts: PlanLimitCounts;
    readonly nextResetAt: number | undefined;
    // Accounts needing manual action only; a spent pool isn't broken, it already refills on its own schedule.
    readonly attention: readonly PlanLimitRow[];
}

export const planLimitSummary = (rows: readonly PlanLimitRow[], now: number = Date.now()): PlanLimitSummary => ({
    accounts: rows.length,
    counts: countBands(rows),
    nextResetAt: nextReset(rows, now),
    attention: rows.filter((row) => row.needsReauth),
});
