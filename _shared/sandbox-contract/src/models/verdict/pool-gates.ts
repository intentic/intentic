import type { AccountUsage, UsageWindow, WindowGates } from "../../schemas/providers/plan-limits.js";

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
