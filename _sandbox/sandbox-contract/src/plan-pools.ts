import type { AccountUsage, UsageWindow, WindowGates } from "./schemas/plan-limits.js";

/* WHICH OF AN ACCOUNT'S POOLS STAND BETWEEN A TURN AND A MODEL, read once, for both sides of the wire.
 *
 * Every question about headroom is really a question about ONE model: which account should serve this Haiku
 * call, is this Google fleet spent for Claude Opus, when does the pool that refused this turn reopen, what
 * does the ring beside the composer measure. The pools a reading carries answer that only through their
 * `gates` (UsageWindowSchema says why the reader decides them), and this file is the one place the gate is
 * read, so the daemon's account picker, its quick-model walk, its refusal dressing and the browser's rings,
 * rail and picker rows all agree about which pool is binding for a given model.
 *
 * WITHOUT A MODEL the answer is the account's own tightest pool, which is what a roster or a rail that has not
 * chosen a model yet is asking. Pools gated to `none` are left out of that too: a code-review limit is the
 * account's to see, never the thing that decides whether a chat turn can run. */

/* WHEN A POOL HAS NOTHING LEFT IN IT, on the wire's own scale, read the same way by both sides.
 *
 * 100, and deliberately not the browser's 90 (usageStatus' SPENT_PERCENT): the two thresholds answer different
 * questions. 90 is a WARNING — the point at which a surface stops recommending an account for a long turn, and
 * what the rings and the bands take their red from. This is EXHAUSTION: the point past which a call is certain
 * to be refused, which is what the daemon needs before it steers a turn elsewhere and the only line a list of
 * offers may hide an account behind. A subscription with a tenth of its week left can still run the next task,
 * and dropping it off a rail titled "Ready to run" answers the reader's question with the wrong one. */
export const SPENT_UTILIZATION = 100;

export interface ModelRef {
    // The wire id ("claude-opus-4-6", "gemini-3-pro").
    readonly id: string;
    // What the picker calls it ("Claude Opus 4.6"), when the caller has it. Both are matched, because which of
    // the two carries the tier word differs by vendor.
    readonly label?: string | undefined;
}

/* TOKENS, NOT SUBSTRINGS. A pool is named by the plan ("Opus", "gemini") and the model by its vendor
 * ("claude-opus-4-6", "Claude Opus 4.6"), and the two only ever agree on a word. A substring test would match
 * "opus" inside an id that merely mentions it, and a normalized-string equality would match nothing at all. */
export const wordsOf = (text: string): readonly string[] =>
    text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);

// Whether `needle` appears as a run of whole words in `words`: "claude opus" is in "claude-opus-4-6", "opus" is
// in "Claude Opus 4.6", and "sonnet" is in neither.
export const runOfWords = (words: readonly string[], needle: readonly string[]): boolean =>
    needle.length > 0 && words.some((_, at) => needle.every((word, index) => words[at + index] === word));

const nameMatches = (name: string, model: ModelRef): boolean => {
    const needle = wordsOf(name);
    return runOfWords(wordsOf(model.id), needle) || (model.label !== undefined && runOfWords(wordsOf(model.label), needle));
};

export const gatesModel = (gates: WindowGates, model: ModelRef): boolean =>
    gates === "all" ? true : gates === "none" ? false : gates.models.some((name) => nameMatches(name, model));

// The pools that gate a model, or, with no model named, every pool that gates anything at all.
export const gatingWindows = (usage: AccountUsage | undefined, model?: ModelRef): readonly UsageWindow[] =>
    (usage?.windows ?? []).filter((window) => (model === undefined ? window.gates !== "none" : gatesModel(window.gates, model)));

const fullest = (windows: readonly UsageWindow[]): UsageWindow | undefined =>
    windows.reduce<UsageWindow | undefined>((worst, window) => (worst === undefined || window.utilization > worst.utilization ? window : worst), undefined);

/* THE POOL THAT WILL GATE THE NEXT TURN: the fullest of the ones this model spends. A single headroom number
 * can only ever be this one, the account is as constrained as its tightest allowance, whichever that happens
 * to be today. Undefined when nothing gates the model (or nothing was measured), which every reader keeps
 * distinct from a measured 0%. */
export const bindingWindow = (usage: AccountUsage | undefined, model?: ModelRef): UsageWindow | undefined => fullest(gatingWindows(usage, model));

/* THE POOL A PLAN METERS THIS MODEL BY ON ITS OWN, when it does: the model-scoped window whose name is the most
 * specific match. Distinct from bindingWindow, which answers "what stops the next turn" and may well be the
 * all-models weekly; this answers "does the plan keep a separate allowance for this tier", which is what a
 * sentence naming the allowance wants ("Opus 82% used").
 *
 * AMBIGUITY ANSWERS NOTHING. Two pools matching one model at the same specificity (a plan metering "Opus" and
 * "Claude Opus" separately, or the same name twice) means we cannot say which allowance a turn spends, so the
 * more specific one wins and a tie returns undefined: no sentence beats a sentence naming the wrong pool. */
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
