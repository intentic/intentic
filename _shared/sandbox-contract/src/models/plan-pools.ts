import type { AccountState, AccountUsage, ProviderRefusal, UsageWindow, WindowGates } from "../schemas/providers/plan-limits.js";

// Single reading of which account pool gates a given model (or, with none named, the account's tightest pool), shared
// by the daemon's picker/refusal logic and the browser's rings and rail. A pool gated `none` is excluded from the
// no-model case: visible to the account, never a gate on a turn.

// 100 = exhaustion (the call will be refused). The one spent line: the daemon's pickers and every surface read it, and
// anything short of it still has room.
export const SPENT_UTILIZATION = 100;

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

// Pools that gate this model, or, with no model given, every pool that gates anything.
export const gatingWindows = (usage: AccountUsage | undefined, model?: ModelRef): readonly UsageWindow[] =>
    (usage?.windows ?? []).filter((window) => (model === undefined ? window.gates !== "none" : gatesModel(window.gates, model)));

const fullest = (windows: readonly UsageWindow[]): UsageWindow | undefined =>
    windows.reduce<UsageWindow | undefined>((worst, window) => (worst === undefined || window.utilization > worst.utilization ? window : worst), undefined);

// The pool that gates the next turn: the fullest of the windows this model spends. Undefined means nothing gates it (or
// nothing was measured) — distinct from a measured 0%.
export const bindingWindow = (usage: AccountUsage | undefined, model?: ModelRef): UsageWindow | undefined => fullest(gatingWindows(usage, model));

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
    readonly cooling?: { readonly until?: number | undefined; readonly reason?: string | undefined } | undefined;
    readonly usage?: AccountUsage | undefined;
}

// A spent allowance is over once a reading with room lands after it; a refused credential once any reading does (the
// token worked). Nothing a reading says answers an entitlement refusal: a seatless account authenticates and reads fine.
const answers = (refusal: ProviderRefusal, facts: ServiceFacts): boolean => {
    const measuredAt = facts.usage?.measuredAt;
    if (refusal.kind === "entitlement" || measuredAt === undefined || measuredAt <= refusal.at) {
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
 * the account it named is disconnected, `answered` once that account (or, for a refusal naming none, any account) has a
 * later reading that contradicts it, else `standing`. An empty list is one not loaded yet, so the refusal stands.
 */
export const refusalVerdict = (refusal: ProviderRefusal, accounts: readonly ServiceFacts[]): "standing" | "answered" | "gone" => {
    const named = accounts.filter((facts) => facts.account === refusal.account);
    if (refusal.account !== undefined && named.length === 0) {
        return accounts.length === 0 ? "standing" : "gone";
    }
    return (refusal.account === undefined ? accounts : named).some((facts) => answers(refusal, facts)) ? "answered" : "standing";
};

// The account reopens for this question when the pools holding it shut do: all of them for a model's own question (or
// the pools gating every model), the first to reopen when only per-model slices are full. Unknown if any is unpublished.
const reopening = (full: readonly UsageWindow[], first: boolean): number | undefined => {
    const resets = full.flatMap((window) => (window.resetsAt === undefined ? [] : [window.resetsAt]));
    return resets.length === full.length && resets.length > 0 ? (first ? Math.min(...resets) : Math.max(...resets)) : undefined;
};

const spent = (reopensAt: number | undefined): AccountState => (reopensAt === undefined ? { kind: "spent" } : { kind: "spent", reopensAt });

/**
 * The plan-limit half of the verdict, at the contract's one spent line. With a model, the pools that model spends: spent
 * once any is full, else the room the fullest leaves. With none, whether the account can serve SOME turn: spent once a
 * pool gating every model is full, or every per-model slice is; a full slice alone (Opus at 100%) leaves the other
 * models their room, which is then read off the fullest pool still open.
 */
export const headroomState = (usage: AccountUsage | undefined, model?: ModelRef): AccountState => {
    const windows = gatingWindows(usage, model);
    if (windows.length === 0) {
        return { kind: "unknown" };
    }
    const full = windows.filter((window) => window.utilization >= SPENT_UTILIZATION);
    const open = windows.filter((window) => window.utilization < SPENT_UTILIZATION);
    if (model !== undefined || full.some((window) => window.gates === "all") || open.length === 0) {
        const holding = model !== undefined ? full : full.some((window) => window.gates === "all") ? full.filter((window) => window.gates === "all") : full;
        if (holding.length > 0) {
            return spent(reopening(holding, model === undefined && !holding.some((window) => window.gates === "all")));
        }
    }
    return { kind: "ready", room: SPENT_UTILIZATION - Math.max(...open.map((window) => window.utilization)) };
};

// A standing limit refusal reads its pool as full, since a polled reading freezes the moment a pool actually empties: the
// pool the refused turn's model spends, else the one asked about, else the tightest. Never another model's allowance.
const refusedPool = (usage: AccountUsage | undefined, refusal: ProviderRefusal, model: ModelRef | undefined): AccountState => {
    const refusedModel = refusal.model === undefined ? model : { id: refusal.model };
    const binding = bindingWindow(usage, refusedModel);
    if (usage === undefined || binding === undefined) {
        // No pool to pin: the refusal itself is the evidence, unless it was about a different model than this question.
        const sameModel = refusal.model === undefined || model === undefined || refusal.model === model.id;
        return sameModel ? { kind: "spent" } : headroomState(usage, model);
    }
    const pinned = usage.windows.map((window) => (window === binding ? { ...window, utilization: Math.max(window.utilization, SPENT_UTILIZATION) } : window));
    return headroomState({ ...usage, windows: pinned }, model);
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
    // A bench with no instant is one no wait lifts (a Google account with no project): somebody has to connect again.
    if (cooling !== undefined && cooling.until === undefined) {
        return { kind: "blocked", fix: "reconnect", reason: cooling.reason ?? "benched by the translator" };
    }
    if (cooling?.until !== undefined && cooling.until * 1000 > now) {
        return { kind: "blocked", fix: "wait", reason: cooling.reason ?? "cooling down", until: cooling.until };
    }
    return refusal?.kind === "limit" ? refusedPool(facts.usage, refusal, model) : headroomState(facts.usage, model);
};

/** Every account of one provider, judged together, since a refusal naming no account is answered by any of them. */
export const serviceStates = (
    accounts: readonly ServiceFacts[],
    refusal: ProviderRefusal | undefined,
    model?: ModelRef,
    now: number = Date.now(),
): ReadonlyMap<string, AccountState> => {
    const standing = refusal !== undefined && refusalVerdict(refusal, accounts) === "standing" ? refusal : undefined;
    return new Map(
        accounts.map((facts) => [
            facts.account,
            serviceState(facts, standing !== undefined && (standing.account ?? facts.account) === facts.account ? standing : undefined, model, now),
        ]),
    );
};

// Worst last: proven room, no reading either way, known spent, and nothing a turn can run on.
const PREFERENCE: Record<AccountState["kind"], number> = { ready: 0, unknown: 1, spent: 2, blocked: 3 };

/** The account an unnamed turn runs on: ready by most room, then unmeasured, then spent, blocked only when that is all there is. Ties keep the caller's order. */
export const preferredAccount = <T extends { readonly state: AccountState }>(entries: readonly T[]): T | undefined =>
    entries.reduce<T | undefined>((best, next) => {
        if (best === undefined) {
            return next;
        }
        const tier = PREFERENCE[next.state.kind] - PREFERENCE[best.state.kind];
        return tier < 0 || (tier === 0 && next.state.kind === "ready" && best.state.kind === "ready" && next.state.room > best.state.room) ? next : best;
    }, undefined);

/** The roomiest account with proven room, or none: what a move off a refused account may land on. Ties keep the caller's order. */
export const roomiestAccount = <T extends { readonly state: AccountState }>(entries: readonly T[]): T | undefined =>
    preferredAccount(entries.filter((entry) => entry.state.kind === "ready"));
