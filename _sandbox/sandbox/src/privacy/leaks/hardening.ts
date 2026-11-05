import {
    PRIVACY_OWN_LIST_WORDS_MAX,
    PRIVACY_OWN_LISTS_MAX,
    PRIVACY_RULES_MAX,
    patternProblem,
    type PrivacyOwnNameList,
    type PrivacyRule,
    type PrivacyShieldPolicy,
} from "@intentic/sandbox-contract/schemas/privacy";
import {
    leakWordsOf,
    type PrivacyHardening,
    type PrivacyHardeningMeasure,
    type PrivacyHardeningSample,
    type PrivacyLeak,
    type PrivacyLeakCaught,
    type PrivacyLeakWord,
} from "@intentic/sandbox-contract/schemas/privacy-leaks";
import type { Candidate } from "@intentic/privacy-detect";
import type { EntityRecognizer } from "../masker.js";
import { detectorFor } from "../policy-detector.js";
import { opt } from "../../opt.js";
import { labelBefore, outlineOf, valueAt } from "./leak-outline.js";

// What a hardening proposal does to the policy, and what it measures: the leaks it catches that nothing catches now, and
// what it would mask in recent text that nothing masks today. Everything here reads the detectors and the owner's rules
// alone, never the vault: a confirmed leak's exact value is already in the vault, so asking the vault would call every
// leak caught, and the question is whether the NEXT value like it would be.

export type LeakWordReader = (word: PrivacyLeakWord) => string | undefined;

// A leak's word by its position, from the leaks as kept.
export const leakWordReader =
    (leaks: readonly PrivacyLeak[]): LeakWordReader =>
    ({ leak, word }) => {
        const found = leaks.find((each) => each.id === leak);
        return found === undefined ? undefined : leakWordsOf(found.value)[word];
    };

const RULE_PROBLEMS = {
    invalid: "is not a regular expression the shield can read",
    tooLong: "is too long",
    empty: "matches empty text, so it would mask nothing and cost every request",
    nested: "repeats a group that repeats inside itself, like (a+)+, which can hold the daemon for minutes on one line; write it without the nested repeat",
} as const;

// Why each proposed rule could not be saved as written; empty when every one could.
export const hardeningProblems = (hardening: PrivacyHardening): string[] =>
    hardening.rules.flatMap((rule) => {
        if (rule.match === "terms") {
            return rule.terms.some((term) => term.trim() !== "") ? [] : [`The rule "${rule.title}" lists no terms.`];
        }
        const problem = patternProblem(rule.pattern);
        return problem === undefined ? [] : [`The rule "${rule.title}": its pattern ${RULE_PROBLEMS[problem]}.`];
    });

const sameTitle = (left: string, right: string): boolean => left.trim().toLowerCase() === right.trim().toLowerCase();

// The policy with the proposal's rules added (switched on, under ids `<prefix>-r<n>`) and its words added onto the owner's
// own list of the same title and kind, or a new one (`<prefix>-l<n>`). A leak word that cannot be read is left out.
// Throws when the result would pass a list's or the policy's limits: applying it would be refused anyway.
export const withHardening = (policy: PrivacyShieldPolicy, hardening: PrivacyHardening, wordOf: LeakWordReader, prefix: string): PrivacyShieldPolicy => {
    const rules: PrivacyRule[] = hardening.rules.map((rule, index) => ({
        id: `${prefix}-r${String(index + 1)}`,
        on: true,
        title: rule.title,
        class: rule.class,
        match: rule.match,
        terms: rule.terms,
        pattern: rule.pattern,
        matchCase: rule.matchCase,
    }));
    let lists: PrivacyOwnNameList[] = [...policy.dictionary.lists];
    hardening.lists.forEach((proposed, index) => {
        const words = [
            ...proposed.words,
            ...proposed.fromLeaks.flatMap((word) => {
                const read = wordOf(word);
                return read === undefined ? [] : [read];
            }),
        ];
        const existing = lists.findIndex((list) => list.kind === proposed.kind && sameTitle(list.title, proposed.title));
        const current = lists[existing];
        if (current !== undefined) {
            const have = new Set(current.words.map((word) => word.toLowerCase()));
            lists = lists.with(existing, { ...current, on: true, words: [...current.words, ...words.filter((word) => !have.has(word.toLowerCase()))] });
            return;
        }
        lists = [
            ...lists,
            {
                id: `${prefix}-l${String(index + 1)}`,
                title: proposed.title,
                kind: proposed.kind,
                matching: proposed.matching,
                words: [...new Set(words)],
                on: true,
            },
        ];
    });
    const next: PrivacyShieldPolicy = { ...policy, rules: [...policy.rules, ...rules], dictionary: { ...policy.dictionary, lists } };
    if (next.rules.length > PRIVACY_RULES_MAX) {
        throw new Error(`The policy holds at most ${String(PRIVACY_RULES_MAX)} rules; this would make ${String(next.rules.length)}.`);
    }
    if (lists.length > PRIVACY_OWN_LISTS_MAX) {
        throw new Error(`The policy holds at most ${String(PRIVACY_OWN_LISTS_MAX)} own name lists; this would make ${String(lists.length)}.`);
    }
    const crowded = lists.find((list) => list.words.length > PRIVACY_OWN_LIST_WORDS_MAX);
    if (crowded !== undefined) {
        throw new Error(`The list "${crowded.title}" would hold more than ${String(PRIVACY_OWN_LIST_WORDS_MAX)} words.`);
    }
    return next;
};

// What the policy's detectors, name lists, rules and (when asked) the local name model find in a text, through the gate.
const findsIn = async (policy: PrivacyShieldPolicy, text: string, recognizer?: EntityRecognizer): Promise<Candidate[]> => {
    const detector = detectorFor(policy);
    const modelled: Candidate[] = recognizer === undefined ? [] : (await recognizer.find(text)).map((span) => ({ ...span, by: "model" }));
    return detector.gate.settle(text, [...detector.candidates(text), ...modelled]);
};

// The text a leak is measured in, and where its value sits there: its context when the context holds it, else the value alone.
const leakText = (leak: Pick<PrivacyLeak, "value" | "context">): { readonly text: string; readonly at: number } => {
    const at = valueAt(leak.context, leak.value);
    return at === undefined ? { text: leak.value, at: 0 } : { text: leak.context, at };
};

const overlaps = (span: { readonly start: number; readonly end: number }, start: number, end: number): boolean => span.start < end && span.end > start;

// What finds a leak with the policy as saved, its vault copy aside: a find over at least half of the value counts.
export const caughtBy = async (policy: PrivacyShieldPolicy, leak: Pick<PrivacyLeak, "value" | "context">, recognizer?: EntityRecognizer): Promise<PrivacyLeakCaught> => {
    const { text, at } = leakText(leak);
    const end = at + leak.value.length;
    const half = leak.value.length / 2;
    const hit = (await findsIn(policy, text, recognizer)).find(
        (span) => overlaps(span, at, end) && Math.min(span.end, end) - Math.max(span.start, at) >= half,
    );
    if (hit === undefined) {
        return "no";
    }
    return hit.by === "rule" ? "rule" : hit.by === "model" ? "model" : "detector";
};

export interface MeasureInput {
    readonly policy: PrivacyShieldPolicy;
    readonly hardening: PrivacyHardening;
    readonly leaks: readonly PrivacyLeak[];
    // Recent text on this machine, each a conversation's.
    readonly control: readonly string[];
    readonly reveal: boolean;
    readonly recognizer?: EntityRecognizer | undefined;
}

const SAMPLES_MAX = 12;

// Each confirmed leak, caught by the policy as saved and by it with the additions.
const measureLeaks = async (
    policy: PrivacyShieldPolicy,
    runnable: PrivacyShieldPolicy,
    leaks: readonly PrivacyLeak[],
    recognizer: EntityRecognizer | undefined,
): Promise<PrivacyHardeningMeasure["leaks"]> => {
    const confirmed = leaks.filter((leak) => leak.state === "confirmed");
    let before = 0;
    const missed: string[] = [];
    for (const leak of confirmed) {
        before += (await caughtBy(policy, leak, recognizer)) === "no" ? 0 : 1;
        if ((await caughtBy(runnable, leak, recognizer)) === "no") {
            missed.push(leak.id);
        }
    }
    return { total: confirmed.length, before, after: confirmed.length - missed.length, missed };
};

// One value only the additions mask, as a reader is shown it.
const sampleOf = (text: string, span: Candidate, runnable: PrivacyShieldPolicy, reveal: boolean): PrivacyHardeningSample => {
    const label = labelBefore(text, span.start, detectorFor(runnable).lexicon);
    return { class: span.class, outline: outlineOf(span.value), ...opt("label", label), ...opt("value", reveal ? span.value : undefined) };
};

// Every value the additions mask in the control text that the policy as saved does not, a leak's own value aside. The
// model reads both sides alike, so the difference is the additions' alone; it is left out here for speed.
const measureControl = async (
    policy: PrivacyShieldPolicy,
    runnable: PrivacyShieldPolicy,
    control: readonly string[],
    leaks: readonly PrivacyLeak[],
    reveal: boolean,
): Promise<PrivacyHardeningMeasure["control"]> => {
    const leakValues = new Set(leaks.map((leak) => leak.value.toLowerCase()));
    let added = 0;
    const samples: PrivacyHardeningSample[] = [];
    for (const text of control) {
        const was = await findsIn(policy, text);
        const fresh = (await findsIn(runnable, text)).filter(
            (span) => !was.some((old) => overlaps(old, span.start, span.end)) && !leakValues.has(span.value.toLowerCase()),
        );
        added += fresh.length;
        samples.push(...fresh.slice(0, SAMPLES_MAX - samples.length).map((span) => sampleOf(text, span, runnable, reveal)));
    }
    const chars = control.reduce((total, text) => total + text.length, 0);
    return { conversations: control.length, chars, added, samples };
};

// The proposal measured: against every confirmed leak, and against the control text.
export const measureHardening = async ({ policy, hardening, leaks, control, reveal, recognizer }: MeasureInput): Promise<PrivacyHardeningMeasure> => {
    const problems = hardeningProblems(hardening);
    const after = withHardening(policy, hardening, leakWordReader(leaks), "try");
    // A rule that cannot run is measured as absent, as saving would refuse it.
    const runnable: PrivacyShieldPolicy = { ...after, rules: after.rules.filter((rule) => rule.match === "terms" || patternProblem(rule.pattern) === undefined) };
    return {
        leaks: await measureLeaks(policy, runnable, leaks, recognizer),
        control: await measureControl(policy, runnable, control, leaks, reveal),
        problems,
    };
};
