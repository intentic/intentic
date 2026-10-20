import type { AccountState, AccountUsage, ProviderRefusal, UsageWindow, WindowGates } from "../schemas/providers/plan-limits.js";

// Single reading of which account pool gates a given model (or, with none named, the account's tightest pool), shared
// by the daemon's picker/refusal logic and the browser's rings and rail. A pool gated `none` is excluded from the
// no-model case: visible to the account, never a gate on a turn.

// 100 = exhaustion (the call will be refused). The one spent line: the daemon's pickers and every surface read it, and
// anything short of it still has room.
export const SPENT_UTILIZATION = 100;

// Whether a reading proves its pool empty. A pool read at the line by a provider that rounds to whole percents
// (`rounded`) does not: Anthropic reports 99.5% as 100 and keeps serving turns on it, so treating that as spent strands
// the last of an allowance (and turns a plain send into one scheduled for the reset). Such a pool is at the line, with
// no room to rank by; only the provider's refusal (pinnedFull) proves it empty.
export const provenFull = (window: UsageWindow): boolean => window.utilization >= SPENT_UTILIZATION && window.rounded !== true;

// A pool a standing limit refusal shows full: at the line, and proven so whatever the provider's rounding.
export const pinnedFull = (window: UsageWindow): UsageWindow => {
    const { rounded: _rounded, ...pool } = window;
    return { ...pool, utilization: Math.max(window.utilization, SPENT_UTILIZATION) };
};

export interface ModelRef {
    // Wire model id.
    readonly id: string;
    // Display name, when available; matched too, since the tier word may be in either id or label.
    readonly label?: string | undefined;
}

// Splits into lowercase alnum words for whole-word matching: a substring test would match "opus" inside a word that
// merely contains it.
export const wordsOf = (text: string): readonly string[] =>
    text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);

// Whether `needle` appears as a contiguous run of whole words within `words`.
export const runOfWords = (words: readonly string[], needle: readonly string[]): boolean =>
    needle.length > 0 && words.some((_, at) => needle.every((word, index) => words[at + index] === word));

const nameMatches = (name: string, model: ModelRef): boolean => {
    const needle = wordsOf(name);
    return runOfWords(wordsOf(model.id), needle) || (model.label !== undefined && runOfWords(wordsOf(model.label), needle));
};

export const gatesModel = (gates: WindowGates, model: ModelRef): boolean =>
    gates === "all" ? true : gates === "none" ? false : gates.models.some((name) => nameMatches(name, model));

// Served models no pool in `windows` gates: what a reading cannot say anything about. A pool gated `none` covers
// nothing, and one gated `all` covers every model.
export const uncoveredModels = (windows: readonly UsageWindow[], served: readonly ModelRef[]): string[] =>
    served.filter((model) => !windows.some((window) => gatesModel(window.gates, model))).map((model) => model.id);

// Pools that gate this model, or, with no model given, every pool that gates anything.
export const gatingWindows = (usage: AccountUsage | undefined, model?: ModelRef): readonly UsageWindow[] =>
    (usage?.windows ?? []).filter((window) => (model === undefined ? window.gates !== "none" : gatesModel(window.gates, model)));

const fullest = (windows: readonly UsageWindow[]): UsageWindow | undefined =>
    windows.reduce<UsageWindow | undefined>((worst, window) => (worst === undefined || window.utilization > worst.utilization ? window : worst), undefined);

// The pool that gates the next turn: the fullest of the windows this model spends. Undefined means nothing gates it (or
// nothing was measured) — distinct from a measured 0%.
export const bindingWindow = (usage: AccountUsage | undefined, model?: ModelRef): UsageWindow | undefined => fullest(gatingWindows(usage, model));

/**
 * Whether a turn answered on `served` proves `other` had room on this account too: every pool `other` spends gates
 * `served` as well, so the answer went through each of them. False where nothing is read, and where `other` spends a pool
 * of its own (Claude's Opus slice, a model the plan has no entitlement to), which another model's answer says nothing
 * about. Codex meters every model from one allowance, so a Luna turn going through proves Sol's allowance open as well.
 */
export const answerCovers = (usage: AccountUsage | undefined, served: ModelRef, other: ModelRef): boolean => {
    const pools = gatingWindows(usage, other);
    return pools.length > 0 && pools.every((window) => gatesModel(window.gates, served));
};

// The model's own metered pool, by most specific name match; distinct from bindingWindow, which may answer with an
// all-models pool. Two matches tied in specificity return undefined rather than guess.
export const scopedWindow = (usage: AccountUsage | undefined, model: ModelRef): UsageWindow | undefined => {
    const matched = (usage?.windows ?? [])
        .flatMap((window) => {
            if (window.gates === "all" || window.gates === "none") {
                return [];
            }
            const specificity = Math.max(0, ...window.gates.models.filter((name) => nameMatches(name, model)).map((name) => wordsOf(name).length));
            return specificity === 0 ? [] : [{ window, specificity }];
        })
        .toSorted((left, right) => right.specificity - left.specificity);
    const best = matched[0];
    if (best === undefined || matched[1]?.specificity === best.specificity) {
        return undefined;
    }
    return best.window;
};

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

// Whether an account can serve a turn: the one rule every picker and surface reads (AccountState). The daemon runs it and
// publishes the verdict on each account row; the editor runs it only on a row from a daemon older than that field.

/** Everything the serviceability rule reads of one account, as the account rows already carry it. */
export interface ServiceFacts {
    // The daemon's key: a native account's id, a routed credential's auth-file name.
    readonly account: string;
    readonly needsReauth?: boolean | undefined;
    // Why the sign-in needs renewing, where the provider said.
    readonly detail?: string | undefined;
    readonly seatRefusal?: string | undefined;
    readonly cooling?: { readonly until?: number | undefined; readonly reason?: string | undefined; readonly verify?: string | undefined } | undefined;
    readonly usage?: AccountUsage | undefined;
    // How the account is named to a person (its label, a routed credential's address); a surface that quotes a figure
    // says whose it is.
    readonly label?: string | undefined;
}

// A spent allowance is over once a reading with room lands after it; a refused credential once any reading does (the
// token worked). Nothing a reading says answers an entitlement refusal: a seatless account authenticates and reads fine.
// Nor does the refused account's own reading answer an allowance it does not measure (`unmetered`: an admin's credit).
// `measured` says whether this reading can speak to the allowance at all: false for that account's own, true for any
// account's where nothing says which one refused (refusalVerdict).
const answers = (refusal: ProviderRefusal, facts: ServiceFacts, measured: boolean = refusal.unmetered !== true): boolean => {
    const measuredAt = facts.usage?.measuredAt;
    if (refusal.kind === "entitlement" || !measured || measuredAt === undefined || measuredAt <= refusal.at) {
        return false;
    }
    if (refusal.kind === "auth") {
        return facts.needsReauth !== true;
    }
    const binding = bindingWindow(facts.usage);
    return binding !== undefined && binding.utilization < SPENT_UTILIZATION;
};

/**
 * How a provider's last refusal stands against everything read since, over every account the provider holds: `gone` once
 * the account it named is disconnected, `answered` once the instant it named has passed or once that account (or, for a
 * refusal naming none, any account) has a later reading that contradicts it, else `standing`. An empty list is one not
 * loaded yet, so the refusal stands.
 */
export const refusalVerdict = (
    refusal: ProviderRefusal,
    accounts: readonly ServiceFacts[],
    now: number = Date.now(),
): "standing" | "answered" | "gone" => {
    const named = accounts.filter((facts) => facts.account === refusal.account);
    if (refusal.account !== undefined && named.length === 0) {
        return accounts.length === 0 ? "standing" : "gone";
    }
    // The provider's own "try again at" is over at that instant, whichever account it refused.
    if (refusal.kind === "limit" && refusal.resetsAt !== undefined && refusal.resetsAt * 1000 <= now) {
        return "answered";
    }
    // Where it is known which account it refused (it named one, or there is only one), the provider's own instant
    // outranks a usage endpoint that kept showing room while it refused: over at that instant, and not before.
    const known = refusal.account !== undefined || accounts.length <= 1;
    if (refusal.kind === "limit" && refusal.resetsAt !== undefined && known) {
        return "standing";
    }
    if (known) {
        return (refusal.account === undefined ? accounts : named).some((facts) => answers(refusal, facts)) ? "answered" : "standing";
    }
    /* A nameless refusal over several accounts is one of them saying no, and nothing says which: the translator benches
       the one it refused and routes on, so any of them reading room since answers it, whatever kind of allowance it was
       and whatever instant it named. Held to its instant, or to an allowance no reading measures, one team account's
       refusal held every Codex account spent for a day, the two free ones reading 0% used included (2026-10-19). */
    return accounts.some((facts) => answers(refusal, facts, true)) ? "answered" : "standing";
};

// The account reopens for this question when the pools holding it shut do: all of them for a model's own question (or
// the pools gating every model), the first to reopen when only per-model slices are full. Unknown if any is unpublished.
const reopening = (full: readonly UsageWindow[], first: boolean): number | undefined => {
    const resets = full.flatMap((window) => (window.resetsAt === undefined ? [] : [window.resetsAt]));
    return resets.length === full.length && resets.length > 0 ? (first ? Math.min(...resets) : Math.max(...resets)) : undefined;
};

const spent = (reopensAt: number | undefined): AccountState => (reopensAt === undefined ? { kind: "spent" } : { kind: "spent", reopensAt });

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
 * What the polled reading ALONE says, never whether the account can serve: that is `serviceState`, which also reads the
 * refusals on file, ask it through the daemon's `serviceability`/`allowanceWall` or the editor's `accountState`. A
 * provider that rounds its percentages (Claude does, every pool) is never proven spent here, so a caller reading this
 * as the verdict sees every spent account as open: a pick between two spent accounts re-booked a held turn for "now"
 * that way (2026-10-19). Imported only by the few modules lint allows (.oxlintrc.json, no-restricted-imports), and was
 * named `headroomState` until then.
 *
 * The plan-limit half of the verdict, at the contract's one spent line. With a model, the pools that model spends: spent
 * once any is full, else the room the fullest leaves. With none, whether the account can serve SOME turn: spent once a
 * pool gating every model is full, or every per-model slice is; a full slice alone (Opus at 100%) leaves the other
 * models their room, which is then read off the fullest pool still open.
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
    return spent(reopening(holding, sliced));
};

/**
 * A reading as a standing limit refusal leaves it, for every surface that draws or judges it: the pool the refused turn's
 * model spends (else the one asked about, else the tightest) read full, since a polled reading freezes the moment a pool
 * actually empties, and reopening when the provider said to try again, where it said, over whatever the polled pool last
 * said. Never another model's allowance. The reading as it was where it has no such pool.
 */
export const pinRefused = (usage: AccountUsage | undefined, refusal: ProviderRefusal, model?: ModelRef): AccountUsage | undefined => {
    const binding = bindingWindow(usage, refusal.model === undefined ? model : { id: refusal.model });
    if (usage === undefined || binding === undefined) {
        return usage;
    }
    const pinned = (window: UsageWindow): UsageWindow =>
        refusal.resetsAt === undefined ? pinnedFull(window) : { ...pinnedFull(window), resetsAt: refusal.resetsAt };
    return { ...usage, windows: usage.windows.map((window) => (window === binding ? pinned(window) : window)) };
};

/**
 * The plan-limit verdict on a reading a standing limit refusal covers (pinRefused), the one rule the daemon's verdict and
 * the editor's live re-reading both judge by. Spent until the provider's own "try again at" where it named one: the
 * editor once re-judged the pinned pool by its own reset alone, and drew "spent until 19:55" over a daemon verdict, and a
 * model picker, both saying 15:53 (2026-10-20).
 */
export const refusedHeadroom = (usage: AccountUsage | undefined, refusal: ProviderRefusal, model?: ModelRef): AccountState => {
    const pinned = pinRefused(usage, refusal, model);
    if (pinned === usage) {
        // No pool to pin: the refusal itself is the evidence, unless it was about a different model than this question.
        const sameModel = refusal.model === undefined || model === undefined || refusal.model === model.id;
        return sameModel ? spent(refusal.resetsAt) : readingHeadroom(usage, model);
    }
    const state = readingHeadroom(pinned, model);
    return state.kind === "spent" && refusal.resetsAt !== undefined ? spent(refusal.resetsAt) : state;
};

/**
 * One account's verdict. `refusal` is the provider's last refusal only when it still stands and covers this account
 * (serviceStates decides that). Precedence: a revoked sign-in outranks a lost seat (reconnecting fixes one, nothing here
 * fixes the other), both outrank a standing refusal, then a translator bench, then the plan limits.
 */
export const serviceState = (facts: ServiceFacts, refusal?: ProviderRefusal, model?: ModelRef, now: number = Date.now()): AccountState => {
    if (facts.needsReauth === true) {
        return { kind: "blocked", fix: "reconnect", reason: facts.detail ?? "sign-in expired" };
    }
    if (facts.seatRefusal !== undefined) {
        return { kind: "blocked", fix: "admin", reason: facts.seatRefusal };
    }
    if (refusal?.kind === "auth") {
        return { kind: "blocked", fix: "reconnect", reason: refusal.message };
    }
    if (refusal?.kind === "entitlement") {
        return { kind: "blocked", fix: "admin", reason: refusal.message };
    }
    const cooling = facts.cooling;
    // A bench the provider wants a person for: the account's owner confirms it on the provider's page, and no wait or
    // reconnect here lifts it. Outranks the retry instant, which is only when the proxy will ask again.
    if (cooling?.verify !== undefined) {
        return { kind: "blocked", fix: "verify", reason: cooling.reason ?? "the provider wants this account verified", url: cooling.verify };
    }
    // A bench with no instant is one no wait lifts (a Google account with no project): somebody has to connect again.
    if (cooling !== undefined && cooling.until === undefined) {
        return { kind: "blocked", fix: "reconnect", reason: cooling.reason ?? "benched by the translator" };
    }
    if (cooling?.until !== undefined && cooling.until * 1000 > now) {
        return { kind: "blocked", fix: "wait", reason: cooling.reason ?? "cooling down", until: cooling.until };
    }
    return refusal?.kind === "limit" ? refusedHeadroom(facts.usage, refusal, model) : readingHeadroom(facts.usage, model);
};

/** The refusals a provider's accounts are judged against: its last one, or every one on file (each account's own beside it). */
export type RefusalsOnFile = ProviderRefusal | readonly ProviderRefusal[] | undefined;

const refusalList = (refusals: RefusalsOnFile): readonly ProviderRefusal[] =>
    refusals === undefined ? [] : "kind" in refusals ? [refusals] : refusals;

/**
 * Every account of one provider, judged together, since a refusal naming no account is answered by any of them. Each
 * account answers to the newest refusal that still stands over it: the provider's last one moves on to whichever account
 * said no next, and an account's own refusal on file stays true of it until something answers it.
 */
export const serviceStates = (
    accounts: readonly ServiceFacts[],
    refusals: RefusalsOnFile,
    model?: ModelRef,
    now: number = Date.now(),
): ReadonlyMap<string, AccountState> => {
    const standing = refusalList(refusals)
        .filter((refusal) => refusalVerdict(refusal, accounts, now) === "standing")
        .toSorted((left, right) => right.at - left.at);
    return new Map(
        accounts.map((facts) => [facts.account, serviceState(facts, standing.find((refusal) => (refusal.account ?? facts.account) === facts.account), model, now)]),
    );
};

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

/** The account an unnamed turn runs on: ready by most room, then unmeasured, then at the line, then spent, blocked only when that is all there is. Ties keep the caller's order. */
export const preferredAccount = <T extends { readonly state: AccountState }>(entries: readonly T[]): T | undefined =>
    entries.reduce<T | undefined>((best, next) => {
        if (best === undefined) {
            return next;
        }
        const tier = preference(next.state) - preference(best.state);
        return tier < 0 || (tier === 0 && next.state.kind === "ready" && best.state.kind === "ready" && next.state.room > best.state.room) ? next : best;
    }, undefined);

/**
 * The roomiest account with proven room, or none: what a move off a refused account may land on. Ties keep the caller's
 * order. An account at the line is left out: a move there could be refused in turn, and with one refusal remembered per
 * provider, two such accounts would hand the turn back and forth.
 */
export const roomiestAccount = <T extends { readonly state: AccountState }>(entries: readonly T[]): T | undefined =>
    preferredAccount(entries.filter((entry) => entry.state.kind === "ready" && entry.state.room > 0));
