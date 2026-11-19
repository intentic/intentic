import type { AccountState, AccountUsage, ProviderRefusal, UsageWindow } from "../schemas/providers/plan-limits.js";
import { humanizeModelId } from "./model-label.js";
import { bindingWindow, gatesModel, gatingWindows, type ModelRef, pinnedFull, provenFull, SPENT_UTILIZATION } from "./verdict/pool-gates.js";
import { type RefusalsOnFile, refusedInstant, type ServiceFacts, standingOver } from "./verdict/refusal-verdict.js";
import { windowPeriod } from "./verdict/window-period.js";

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
export { type RefusedInstant, refusedInstant, refusalVerdict, refusedPoolReset, type RefusalsOnFile, type ServiceFacts, standingOver } from "./verdict/refusal-verdict.js";
export { periodWords, type WindowPeriod, windowPeriod } from "./verdict/window-period.js";

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

/* WHEN AN ACCOUNT'S ALLOWANCE RENEWS, which is what a pick between accounts with room weighs first (preferredAccount).
   What is left of a pool when it resets is gone: on 2026-11-17, with Claude's Ultra plan metering no five-hour window,
   the pick kept every turn on the account with the most weekly room, resetting six days out, while another account's
   40% reset unspent ten hours later. The pool that decides is the longest the turn spends, since a shorter one refills
   within the day whichever account is picked; among several of that length (Claude's weekly pool beside its weekly Opus
   slice), the first to reset. Undefined where those publish no reset, or no pool names its length and none resets. */
export const renewalOf = (windows: readonly UsageWindow[]): number | undefined => {
    const periods = windows.map((window) => windowPeriod(window)?.seconds);
    const known = periods.filter((seconds) => seconds !== undefined);
    const longest = known.length === 0 ? undefined : Math.max(...known);
    const deciding = longest === undefined ? windows : windows.filter((_, index) => periods[index] === longest);
    const resets = deciding.flatMap((window) => (window.resetsAt === undefined ? [] : [window.resetsAt]));
    return resets.length === 0 ? undefined : Math.min(...resets);
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
        const room = Math.max(0, SPENT_UTILIZATION - Math.max(...open.map((window) => window.utilization)));
        const renewsAt = renewalOf(open);
        return renewsAt === undefined ? { kind: "ready", room } : { kind: "ready", room, renewsAt };
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
// said to try again, where it said, over whatever the polled pool last said. Never another model's allowance. A refusal
// whose instant no pool of the reading `polled` since resets at is a pool of its own (refusedInstant `unpublished`): a
// Codex refusal on GPT 6.1 Sol naming a reset neither window had pinned the weekly window, which gates every model, so
// every Codex model read spent for four days while both windows showed most of the allowance free (2026-11-14).
const pinRefusal = (usage: AccountUsage | undefined, refusal: ProviderRefusal, model: ModelRef | undefined, polled: AccountUsage | undefined): AccountUsage => {
    const binding = bindingWindow(usage, refusal.model === undefined ? model : { id: refusal.model });
    if (usage === undefined || binding === undefined || refusedInstant(refusal, polled) === "unpublished") {
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
        .reduce<AccountUsage | undefined>((reading, refusal) => pinRefusal(reading, refusal, model, usage), usage);

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

/* A MODEL AN ACCOUNT'S PLAN DOES NOT INCLUDE IS NOT ITS TO SERVE, HOWEVER MUCH ROOM IT HAS. Two ChatGPT Free sign-ins
   back from their monthly reset read 100% left while the translator routed GPT-6.2-Sol only to the Team one, spent for
   two hours: every Sol request skipped both Free ones and met the Team one's bench, the turn was refused, the re-read
   showed both Free ones full of room, the held turn was re-timed to now, and it went round again every two minutes
   (2026-11-19). So an account the source lists models for, without this one, is `blocked` with the `plan` fix for it,
   and for no other model. Judged only where some account of the provider lists the model under exactly this id: a
   listing that names it otherwise (an alias, a thinking suffix) or none at all says nothing about any account. */
const offPlan = (accounts: readonly ServiceFacts[], model: ModelRef | undefined): ((facts: ServiceFacts) => boolean) => {
    const listed = (facts: ServiceFacts): facts is ServiceFacts & { readonly models: readonly string[] } => (facts.models?.length ?? 0) > 0;
    if (model === undefined || !accounts.some((facts) => listed(facts) && facts.models.includes(model.id))) {
        return () => false;
    }
    return (facts) => listed(facts) && !facts.models.includes(model.id);
};

const offPlanState = (model: ModelRef): AccountState => ({
    kind: "blocked",
    fix: "plan",
    reason: `${model.label ?? humanizeModelId(model.id)} is not on this account's plan`,
});

/** Whether a verdict says the account's plan does not include the model it was judged on: outside that model's fleet. */
export const offPlanVerdict = (state: AccountState): boolean => state.kind === "blocked" && state.fix === "plan";

/** Every account of one provider, judged together, since a refusal naming no account is answered by any of them. */
export const serviceStates = (
    accounts: readonly ServiceFacts[],
    refusals: RefusalsOnFile = [],
    model?: ModelRef,
    now: number = Date.now(),
): ReadonlyMap<string, AccountState> => {
    const standing = standingOver(accounts, refusals, now);
    const excluded = offPlan(accounts, model);
    return new Map(
        accounts.map((facts) => [
            facts.account,
            model !== undefined && excluded(facts) ? offPlanState(model) : serviceState(facts, standing(facts.account), model, now),
        ]),
    );
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

/**
 * A provider's capacity for one model from its accounts as already judged on that model (serviceStates). An account whose
 * plan does not include the model is no part of its fleet: never counted, never the reopen.
 */
export const fleetOf = (accounts: readonly ServiceFacts[], states: ReadonlyMap<string, AccountState>): FleetCapacity => {
    const judged = accounts
        .map((facts) => ({ facts, state: states.get(facts.account) ?? ({ kind: "unknown" } as const) }))
        .filter(({ state }) => !offPlanVerdict(state));
    if (judged.length === 0) {
        return { kind: "unknown" };
    }
    const serving = judged.filter(({ state }) => state.kind === "ready" || state.kind === "unknown");
    if (serving.length > 0) {
        const room = serving.flatMap(({ facts, state }) => (state.kind === "ready" && facts.usage !== undefined ? [facts.usage.measuredAt] : []));
        return { kind: "serving", serving: serving.length, accounts: judged.length, roomMeasuredAt: room.length === 0 ? undefined : Math.max(...room) };
    }
    // The soonest instant any account names; one with none only decides the pool where nothing names an instant.
    const soonest = judged.reduce<AccountState | undefined>((best, { state }) => {
        const at = reopensAtOf(state);
        const bestAt = best === undefined ? undefined : reopensAtOf(best);
        return best === undefined || (at !== undefined && (bestAt === undefined || at < bestAt)) ? state : best;
    }, undefined);
    return {
        kind: "spent",
        accounts: judged.length,
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

/* WHICH ACCOUNTS FLAP, judged from the switch-off instants the daemon publishes beside the refusals on file (its
   entitlement-history.ts records them, the refusals feed carries them), so the daemon's pick and every window that
   draws where a turn would run read one rule over one set of facts. Before 2026-11-15 only the daemon knew which
   accounts flapped: the picker ticked a flapping account as where the next turn ran, while the daemon ranked it behind
   a steady one and ran the turn there. Facts rather than a verdict, since a switch-off ages out of the week on the
   clock alone, with nothing pushed when it does. */

// How far back a switch-off counts, and how many in that span make an account flap: once is an organisation's decision,
// a second time within the week is a habit, and the next turn would meet it again.
export const FLAPPING_WINDOW_MS = 7 * 24 * 60 * 60_000;
export const FLAPPING_AFTER = 2;

/** Each account's switch-offs (epoch ms, oldest first), keyed by account id. */
export type SwitchOffs = Readonly<Record<string, readonly number[]>>;

/** The accounts switched off FLAPPING_AFTER times or more in the window before `now`. */
export const flappingAccounts = (switchOffs: SwitchOffs | undefined, now: number): ReadonlySet<string> =>
    new Set(
        Object.entries(switchOffs ?? {}).flatMap(([account, instants]) =>
            instants.filter((at) => at > now - FLAPPING_WINDOW_MS && at <= now).length >= FLAPPING_AFTER ? [account] : [],
        ),
    );

/** What a pick reads of an account: its verdict, and whether its organisation keeps switching it off. */
interface RankedAccount {
    readonly state: AccountState;
    // Refused its entitlement twice or more in the last week (flappingAccounts). Absent: steady.
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
    return next.state.kind === "ready" && best.state.kind === "ready" && readyAbove(next.state, best.state);
};

/** Room at or below this, in points of the fullest pool, is an account nearly out: it ranks after every one with more. */
export const NEARLY_OUT_ROOM = 10;

/* BETWEEN TWO ACCOUNTS WITH ROOM, THE ONE WHOSE ALLOWANCE RENEWS FIRST (renewalOf), unless it is nearly out. Points left
   in a pool at its reset are lost, so spending the pool that resets first wastes the least of what the plans pay for,
   and the later one is still there when the first has renewed. Most room decides only between accounts renewing at the
   same moment, between accounts no reset is known for, and among accounts nearly out, where room is what keeps the next
   turn from being refused. This reads no load: the daemon's own Claude pick (budget-planner.ts pickAccount) orders the
   same way among the accounts its projection says carry the turn with what already runs on them. */
const readyAbove = (next: AccountState & { kind: "ready" }, best: AccountState & { kind: "ready" }): boolean => {
    const nextOpen = next.room > NEARLY_OUT_ROOM;
    if (nextOpen !== best.room > NEARLY_OUT_ROOM) {
        return nextOpen;
    }
    const nextRenews = next.renewsAt ?? Number.POSITIVE_INFINITY;
    const bestRenews = best.renewsAt ?? Number.POSITIVE_INFINITY;
    if (nextOpen && nextRenews !== bestRenews) {
        return nextRenews < bestRenews;
    }
    return next.room > best.room;
};

/**
 * The account an unnamed turn runs on: ready, then unmeasured, then at the line, then spent, blocked only when that is
 * all there is; within each, a flapping account after the steady ones; among ready ones, the first to renew of those not
 * nearly out, then the most room (readyAbove). Ties keep the caller's order.
 */
export const preferredAccount = <T extends RankedAccount>(entries: readonly T[]): T | undefined =>
    entries.reduce<T | undefined>((best, next) => (best === undefined || ranksAbove(next, best) ? next : best), undefined);

/**
 * The best account with proven room, by the same order, or none: what a move off a refused account may land on. Ties keep
 * the caller's order. An account at the line is left out: a move there could be refused in turn, and two such accounts
 * would hand the turn back and forth.
 */
export const bestWithRoom = <T extends RankedAccount>(entries: readonly T[]): T | undefined =>
    preferredAccount(entries.filter((entry) => entry.state.kind === "ready" && entry.state.room > 0));
