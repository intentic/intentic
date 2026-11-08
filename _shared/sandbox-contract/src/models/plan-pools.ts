import type { AccountState, AccountUsage, ProviderRefusal, UsageWindow } from "../schemas/providers/plan-limits.js";
import { humanizeModelId } from "./model-label.js";
import { bindingWindow, gatesModel, gatingWindows, type ModelRef, pinnedFull, provenFull, SPENT_UTILIZATION } from "./verdict/pool-gates.js";
import { type RefusalsOnFile, type ServiceFacts, standingOver } from "./verdict/refusal-verdict.js";

// Which pool gates a model (verdict/pool-gates.ts) and how each refusal on file stands over each account
// (verdict/refusal-verdict.ts), kept beside this module and served from it, so every caller reads the one rule through
// one door.
export {
    answerCovers,
    bindingWindow,
    gatesModel,
    gatingWindows,
    type ModelRef,
    pinnedFull,
    provenFull,
    runOfWords,
    scopedWindow,
    SPENT_UTILIZATION,
    uncoveredModels,
    wordsOf,
} from "./verdict/pool-gates.js";
export { refusalVerdict, refusedPoolReset, type RefusalsOnFile, type ServiceFacts, standingOver } from "./verdict/refusal-verdict.js";

// How long a pool's window runs, read off the provider's own key and whatever name it published. One implementation,
// because two things need it and must agree: a narrow column names the window by `short`, and a reading with no
// published reset instant may only be trusted for `seconds` past the moment it was taken.

export interface WindowPeriod {
    readonly seconds: number;
    // The token a narrow column names this window by, e.g. "5h", "wk".
    readonly short: string;
}

const HOUR_SECONDS = 3_600;
const DAY_SECONDS = 86_400;

/** Kind and label as space-padded lowercase words, underscores split, so `\b` matches across both spellings. */
export const periodWords = (pool: { readonly kind: string; readonly label?: string | undefined }): string =>
    ` ${`${pool.kind} ${pool.label ?? ""}`
        .toLowerCase()
        .replaceAll(/[^a-z0-9]+/gu, " ")
        .trim()} `;

// A count the words spell out, e.g. the 3 in "3 days".
const counted = (words: string, pattern: RegExp): number | undefined => {
    const found = pattern.exec(words)?.[1];
    return found === undefined ? undefined : Number(found);
};

// Day-scale and longer, where the named periods outrank a bare count: "7 days" is the week every plan sells, not a
// seven-day span of its own.
const dayPeriod = (words: string, days: number | undefined): WindowPeriod | undefined => {
    if (days === 7 || /\bseven days?\b|\bweek(ly|s)?\b/u.test(words)) {
        return { seconds: 7 * DAY_SECONDS, short: "wk" };
    }
    if (/\bmonth(ly|s)?\b/u.test(words)) {
        return { seconds: 30 * DAY_SECONDS, short: "mo" };
    }
    if (days === 1 || /\bdaily\b/u.test(words)) {
        return { seconds: DAY_SECONDS, short: "24h" };
    }
    return days === undefined ? undefined : { seconds: days * DAY_SECONDS, short: `${days}d` };
};

/** Window length behind a pool; undefined when neither the key nor the name says how long it runs. */
export const windowPeriod = (pool: { readonly kind: string; readonly label?: string | undefined }): WindowPeriod | undefined => {
    const words = periodWords(pool);
    const hours = counted(words, /\b(\d+) hours?\b/u);
    // Hours first: a pool named both ("5 hours, weekly cap") runs on the shorter clock.
    if (hours !== undefined || /\bfive hours?\b/u.test(words)) {
        const span = hours ?? 5;
        return { seconds: span * HOUR_SECONDS, short: `${span}h` };
    }
    const day = dayPeriod(words, counted(words, /\b(\d+) days?\b/u));
    if (day !== undefined) {
        return day;
    }
    const minutes = counted(words, /\b(\d+) minutes?\b/u);
    return minutes === undefined ? undefined : { seconds: minutes * 60, short: `${minutes}m` };
};

// Whether a reading of this window can still be true. A published reset instant is the authority; with none, the
// window's own length is, since a pool read as empty says nothing about the window that opened after it. A window whose
// length nothing names keeps the old rule: only its reset instant can retire it.
export const windowLive = (window: UsageWindow, measuredAt: number, now: number): boolean => {
    if (window.resetsAt !== undefined) {
        return window.resetsAt * 1000 > now;
    }
    const period = windowPeriod(window);
    return period === undefined || measuredAt + period.seconds * 1000 > now;
};

// A pool whose reading belongs to a window that has since closed: still the account's pool, at the floor any new window
// starts from, and marked with when the old window closed so a surface can say it has not been re-read since.
const lapsedWindow = (window: UsageWindow, measuredAt: number): UsageWindow => {
    const { resetsAt, rounded: _rounded, utilization: _utilization, ...pool } = window;
    // Only reached for a window windowLive retired, so with no published reset its length is known.
    const closedAt = resetsAt ?? Math.floor((measuredAt + (windowPeriod(window)?.seconds ?? 0) * 1000) / 1000);
    return { ...pool, utilization: 0, lapsedAt: closedAt };
};

// What a reading says about each of the account's pools now. A window past its reset is kept rather than dropped, as a
// lapsed pool (lapsedWindow): dropping it made a reading whose re-reads were failing lose its five-hour row within hours
// while the weekly rows stayed, a partial card that reads as complete. The floor of 0 is what dropping it already meant
// to every verdict (an absent pool binds nothing). A reading with no window still current says nothing about now and
// answers none, so the account reads as unmeasured. Idempotent: a pool already lapsed stays as it is.
// A pool the provider stopped reporting (`missingSince`) is dropped instead once its window closes: nothing will read it
// again, so its floor of 0 would be a pool that is not there.
export const currentWindows = (usage: AccountUsage, now: number): UsageWindow[] => {
    const live = (window: UsageWindow): boolean => window.lapsedAt === undefined && windowLive(window, usage.measuredAt, now);
    if (!usage.windows.some(live)) {
        return [];
    }
    return usage.windows.flatMap((window) => {
        if (window.lapsedAt !== undefined || live(window)) {
            return [window];
        }
        return window.missingSince === undefined ? [lapsedWindow(window, usage.measuredAt)] : [];
    });
};

// Whether an account can serve a turn, and what one provider's accounts can serve together: the one rule every picker,
// gate, listing and surface reads. The daemon and the editor run it on the same facts (the account rows and every
// refusal on file); neither keeps a judged copy, so the two cannot disagree.


// The account reopens for this question when the pools holding it shut do: all of them for a model's own question (or
// the pools gating every model), the first to reopen when only per-model slices are full. Unknown if any is unpublished.
const reopening = (full: readonly UsageWindow[], first: boolean): number | undefined => {
    const resets = full.flatMap((window) => (window.resetsAt === undefined ? [] : [window.resetsAt]));
    return resets.length === full.length && resets.length > 0 ? (first ? Math.min(...resets) : Math.max(...resets)) : undefined;
};

// Spent until the pools holding it reopen, named by the one that decides when, where the plan meters it apart (an
// undivided allowance is just "the allowance").
const spentOn = (holding: readonly UsageWindow[], first: boolean): AccountState => {
    const state: AccountState & { kind: "spent" } = { kind: "spent" };
    const reopensAt = reopening(holding, first);
    if (reopensAt !== undefined) {
        state.reopensAt = reopensAt;
    }
    const deciding = holding.find((window) => window.resetsAt === reopensAt) ?? holding[0];
    if (deciding !== undefined && deciding.gates !== "all" && deciding.label !== undefined) {
        state.pool = deciding.label;
    }
    return state;
};

// A turn on the model this reading was contradicted for went through while the pool read full: the pool is at the line,
// not proven empty, exactly as a rounded one is (provenFull).
const answeredDespite = (usage: AccountUsage | undefined, window: UsageWindow): boolean =>
    usage?.contradicted !== undefined && gatesModel(window.gates, { id: usage.contradicted.model });

// The pools holding the account shut: for a model, every full pool it spends; with none, the full pools gating every
// model, else every per-model slice once all of them are full; nothing while one is open.
const holdingPools = (full: readonly UsageWindow[], open: readonly UsageWindow[], model: ModelRef | undefined): readonly UsageWindow[] => {
    if (model !== undefined) {
        return full;
    }
    const wholePlan = full.filter((window) => window.gates === "all");
    if (wholePlan.length > 0) {
        return wholePlan;
    }
    return open.length === 0 ? full : [];
};

/**
 * What a reading says, at the contract's one spent line, never whether the account can serve: that is `serviceStates`,
 * which first lays every standing refusal on the reading (judgedReading). A provider that rounds its percentages (Claude
 * does, every pool) is never proven spent here, so a caller reading a polled reading's verdict as the account's sees every
 * spent account as open: a pick between two spent accounts re-booked a held turn for "now" that way (2026-10-19).
 * Imported only by the few modules lint allows (.oxlintrc.json, no-restricted-imports).
 *
 * With a model, the pools that model spends: spent once any is full, else the room the fullest leaves. With none, whether
 * the account can serve SOME turn: spent once a pool gating every model is full, or every per-model slice is; a full
 * slice alone (Opus at 100%) leaves the other models their room, which is then read off the fullest pool still open.
 */
export const readingHeadroom = (usage: AccountUsage | undefined, model?: ModelRef): AccountState => {
    const windows = gatingWindows(usage, model).map((window) => (answeredDespite(usage, window) ? { ...window, rounded: true } : window));
    if (windows.length === 0) {
        return { kind: "unknown" };
    }
    const full = windows.filter(provenFull);
    const open = windows.filter((window) => !provenFull(window));
    const holding = holdingPools(full, open, model);
    if (holding.length === 0) {
        return { kind: "ready", room: Math.max(0, SPENT_UTILIZATION - Math.max(...open.map((window) => window.utilization))) };
    }
    const sliced = model === undefined && !holding.some((window) => window.gates === "all");
    // Every per-model slice this reading names is full, but it names none for some models the account serves: whether
    // those can run is unknown, not spent. Reading the account spent on this is how every Google account read out of
    // allowance while its Gemini models, whose pool the provider had stopped reporting, still served.
    if (sliced && (usage?.uncovered?.length ?? 0) > 0) {
        return { kind: "unknown" };
    }
    return spentOn(holding, sliced);
};

// What a person calls a refused pool no reading names: the model it refused, or the allowance as a whole.
const REFUSED_ALLOWANCE = "Allowance";

// The pool a limit refusal proves full where no pool of the reading gates the model it refused: a plan that publishes
// nothing (Cursor's, Devin's) or names no pool for that model. Its own, gating only that model (every model, where it
// named none), reopening when the provider said.
const refusedPool = (refusal: ProviderRefusal): UsageWindow => {
    const pool: UsageWindow = {
        kind: `refused:${refusal.model ?? "all"}`,
        label: refusal.model === undefined ? REFUSED_ALLOWANCE : humanizeModelId(refusal.model),
        utilization: SPENT_UTILIZATION,
        gates: refusal.model === undefined ? "all" : { models: [refusal.model] },
    };
    if (refusal.resetsAt !== undefined) {
        pool.resetsAt = refusal.resetsAt;
    }
    return pool;
};

// One limit refusal laid on a reading: the pool the refused turn's model spends (else the one asked about, else the
// tightest) read full, since a polled reading freezes the moment a pool actually empties, and reopening when the provider
// said to try again, where it said, over whatever the polled pool last said. Never another model's allowance.
const pinRefusal = (usage: AccountUsage | undefined, refusal: ProviderRefusal, model: ModelRef | undefined): AccountUsage => {
    const binding = bindingWindow(usage, refusal.model === undefined ? model : { id: refusal.model });
    if (usage === undefined || binding === undefined) {
        return { ...(usage ?? { measuredAt: refusal.at }), windows: [...(usage?.windows ?? []), refusedPool(refusal)] };
    }
    const pinned = pinnedFull(binding);
    // Reopening when the refusal ends (refusalVerdict), so the "back at" every surface draws is when it flips.
    const over = refusal.resetsAt ?? refusal.poolResetsAt;
    if (over !== undefined) {
        pinned.resetsAt = over;
    }
    return { ...usage, windows: usage.windows.map((window) => (window === binding ? pinned : window)) };
};

/**
 * An account's reading as the refusals standing over it leave it: what every surface draws and every verdict judges,
 * never the polled reading alone. Each standing limit refusal is laid on it, oldest first so the newest says when its
 * pool reopens. `standing` is what standingOver answers for the account; a refusal of another kind pins nothing.
 */
export const judgedReading = (usage: AccountUsage | undefined, standing: RefusalsOnFile, model?: ModelRef): AccountUsage | undefined =>
    standing
        .filter((refusal) => refusal.kind === "limit")
        .toSorted((left, right) => left.at - right.at)
        .reduce<AccountUsage | undefined>((reading, refusal) => pinRefusal(reading, refusal, model), usage);

/** The newest of some refusals: the latest word, where a surface says one line about a provider or an account. */
export const newestRefusal = (refusals: RefusalsOnFile): ProviderRefusal | undefined =>
    refusals.reduce<ProviderRefusal | undefined>((newest, refusal) => (newest === undefined || refusal.at > newest.at ? refusal : newest), undefined);

/**
 * One account's verdict on everything on file over it. `standing` is the refusals still standing over it (standingOver).
 * Precedence: a revoked sign-in outranks a lost seat (reconnecting fixes one, nothing here fixes the other), both outrank
 * the newest standing refusal where it refused the account itself, then a translator bench, then the plan limits on the
 * reading the refusals leave (judgedReading).
 */
export const serviceState = (facts: ServiceFacts, standing: RefusalsOnFile = [], model?: ModelRef, now: number = Date.now()): AccountState => {
    if (facts.needsReauth === true) {
        return { kind: "blocked", fix: "reconnect", reason: facts.detail ?? "sign-in expired" };
    }
    if (facts.seatRefusal !== undefined) {
        return { kind: "blocked", fix: "admin", reason: facts.seatRefusal };
    }
    // The newest word on the account: a sign-in or an entitlement refused after any spent allowance blocks it, and a
    // spent allowance refused after either says the account authenticated and was served, so that one is over.
    const newest = newestRefusal(standing);
    if (newest?.kind === "auth") {
        return { kind: "blocked", fix: "reconnect", reason: newest.message };
    }
    if (newest?.kind === "entitlement") {
        return { kind: "blocked", fix: "admin", reason: newest.message };
    }
    const plan = readingHeadroom(judgedReading(facts.usage, standing, model), model);
    return facts.cooling === undefined ? plan : benched(facts.cooling, plan, now);
};

// A translator bench over the plan verdict. One the provider wants a person for: the account's owner confirms it on the
// provider's page, and no wait or reconnect here lifts it, whatever the retry instant says. One with no instant is one no
// wait lifts either (a Google account with no project): somebody has to connect again. One with an instant is the
// translator's own retry, a floor rather than the reopening: a Kimi credential benched for thirty minutes with its
// five-hour window two hours from reopening was re-run at thirty minutes and refused again (2026-10-17), so it lifts once
// its pools have reopened too. Past its instant it is over, and the plan speaks.
const benched = (cooling: NonNullable<ServiceFacts["cooling"]>, plan: AccountState, now: number): AccountState => {
    if (cooling.verify !== undefined) {
        return { kind: "blocked", fix: "verify", reason: cooling.reason ?? "the provider wants this account verified", url: cooling.verify };
    }
    if (cooling.until === undefined) {
        return { kind: "blocked", fix: "reconnect", reason: cooling.reason ?? "benched by the translator" };
    }
    if (cooling.until * 1000 <= now) {
        return plan;
    }
    const until = plan.kind === "spent" && plan.reopensAt !== undefined ? Math.max(cooling.until, plan.reopensAt) : cooling.until;
    return { kind: "blocked", fix: "wait", reason: cooling.reason ?? "cooling down", until };
};

/** Every account of one provider, judged together, since a refusal naming no account is answered by any of them. */
export const serviceStates = (
    accounts: readonly ServiceFacts[],
    refusals: RefusalsOnFile = [],
    model?: ModelRef,
    now: number = Date.now(),
): ReadonlyMap<string, AccountState> => {
    const standing = standingOver(accounts, refusals, now);
    return new Map(accounts.map((facts) => [facts.account, serviceState(facts, standing(facts.account), model, now)]));
};

/** When an account that cannot serve says it can again, in epoch seconds; undefined where its verdict names no instant. */
export const reopensAtOf = (state: AccountState): number | undefined => {
    if (state.kind === "spent") {
        return state.reopensAt;
    }
    return state.kind === "blocked" && state.fix === "wait" ? state.until : undefined;
};

/**
 * What one provider's accounts can do for one model, together: the answer every gate, listing, picker and offer reads,
 * so none can call a model spent that another lets through. An unmeasured account may still answer, so it keeps the
 * model servable; only every account spent or blocked makes it spent.
 */
export type FleetCapacity =
    // No account to judge: nothing on file says either way, so the model is asked.
    | { readonly kind: "unknown" }
    // `serving` of the `accounts` are ready or unmeasured; `roomMeasuredAt` is the newest reading with room among them.
    | { readonly kind: "serving"; readonly serving: number; readonly accounts: number; readonly roomMeasuredAt?: number | undefined }
    // Every account is spent or blocked: `reopensAt` is the soonest any is back (any one unblocks the turn), where one
    // says when, and `pool` what holds that one.
    | { readonly kind: "spent"; readonly accounts: number; readonly reopensAt?: number | undefined; readonly pool?: string | undefined };

/** A provider's capacity for one model from its accounts as already judged on that model (serviceStates). */
export const fleetOf = (accounts: readonly ServiceFacts[], states: ReadonlyMap<string, AccountState>): FleetCapacity => {
    if (accounts.length === 0) {
        return { kind: "unknown" };
    }
    const judged = accounts.map((facts) => ({ facts, state: states.get(facts.account) ?? ({ kind: "unknown" } as const) }));
    const serving = judged.filter(({ state }) => state.kind === "ready" || state.kind === "unknown");
    if (serving.length > 0) {
        const room = serving.flatMap(({ facts, state }) => (state.kind === "ready" && facts.usage !== undefined ? [facts.usage.measuredAt] : []));
        return { kind: "serving", serving: serving.length, accounts: accounts.length, roomMeasuredAt: room.length === 0 ? undefined : Math.max(...room) };
    }
    // The soonest instant any account names; one with none only decides the pool where nothing names an instant.
    const soonest = judged.reduce<AccountState | undefined>((best, { state }) => {
        const at = reopensAtOf(state);
        const bestAt = best === undefined ? undefined : reopensAtOf(best);
        return best === undefined || (at !== undefined && (bestAt === undefined || at < bestAt)) ? state : best;
    }, undefined);
    return {
        kind: "spent",
        accounts: accounts.length,
        reopensAt: soonest === undefined ? undefined : reopensAtOf(soonest),
        pool: soonest?.kind === "spent" ? soonest.pool : undefined,
    };
};

/** A provider's capacity for one model, judged on its accounts and every refusal on file. */
export const fleetCapacity = (accounts: readonly ServiceFacts[], refusals: RefusalsOnFile = [], model?: ModelRef, now: number = Date.now()): FleetCapacity =>
    fleetOf(accounts, serviceStates(accounts, refusals, model, now));

// Worst last: proven room, no reading either way, a pool at the line (it may hold a sliver, or nothing), known spent,
// and nothing a turn can run on.
const preference = (state: AccountState): number => {
    switch (state.kind) {
        case "ready":
            return state.room > 0 ? 0 : 2;
        case "unknown":
            return 1;
        case "spent":
            return 3;
        case "blocked":
            return 4;
    }
};

/** What a pick reads of an account: its verdict, and whether its organisation keeps switching it off. */
interface RankedAccount {
    readonly state: AccountState;
    // Refused its entitlement twice or more in the last week (the daemon's usage/entitlement-history.ts). Absent: steady.
    readonly flapping?: boolean | undefined;
}

/* A FLAPPING ACCOUNT RANKS BEHIND EVERY STEADY ONE OF ITS TIER, whatever its room, for the week after it serves again.
   Claude account d8561075…'s organisation switched Claude Code off at 2026-10-27 08:44, let it serve from 21:17 to
   00:39, and switched it off again at 10-28 08:48. Each time it served, the answered turn settled its refusal, its
   reading showed the most room, and the pick put the next turns back on it until it was refused again. The tier still
   comes first: a flapping account with proven room beats an unmeasured, spent or blocked one. */
const ranksAbove = (next: RankedAccount, best: RankedAccount): boolean => {
    const tier = preference(next.state) - preference(best.state);
    if (tier !== 0) {
        return tier < 0;
    }
    if ((next.flapping === true) !== (best.flapping === true)) {
        return best.flapping === true;
    }
    return next.state.kind === "ready" && best.state.kind === "ready" && next.state.room > best.state.room;
};

/**
 * The account an unnamed turn runs on: ready by most room, then unmeasured, then at the line, then spent, blocked only
 * when that is all there is; within each, a flapping account after the steady ones. Ties keep the caller's order.
 */
export const preferredAccount = <T extends RankedAccount>(entries: readonly T[]): T | undefined =>
    entries.reduce<T | undefined>((best, next) => (best === undefined || ranksAbove(next, best) ? next : best), undefined);

/**
 * The roomiest account with proven room, or none: what a move off a refused account may land on. Ties keep the caller's
 * order. An account at the line is left out: a move there could be refused in turn, and two such accounts would hand the
 * turn back and forth.
 */
export const roomiestAccount = <T extends RankedAccount>(entries: readonly T[]): T | undefined =>
    preferredAccount(entries.filter((entry) => entry.state.kind === "ready" && entry.state.room > 0));
