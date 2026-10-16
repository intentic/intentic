import {
    patternProblem,
    PRIVACY_OWN_LIST_WORDS_MAX,
    PRIVACY_RULE_TERMS_MAX,
    PRIVACY_TERM_MAX,
    PRIVACY_WORD_MAX,
    type PrivacyDictionaryPolicy,
    type PrivacyOwnNameList,
    type PrivacyPatternProblem,
    type PrivacyRule,
    type PrivacyShieldPolicy,
} from "@intentic/sandbox-contract/schemas/privacy";
import type { ValueLimits } from "./privacyShield";

// The owner's own name lists and rules as the privacy page edits them, kept free of Vue so they can be tested on their
// own. The policy route replaces the policy whole, so every change returns a new policy built from the one on screen.

export const OWN_WORD_LIMITS: ValueLimits = { max: PRIVACY_OWN_LIST_WORDS_MAX, length: PRIVACY_WORD_MAX };
export const TERM_LIMITS: ValueLimits = { max: PRIVACY_RULE_TERMS_MAX, length: PRIVACY_TERM_MAX };

// A status cached from a daemon that knew no own lists or rules holds neither; read as none.
type MaybeOwn = Partial<PrivacyShieldPolicy> | undefined;
export const dictionaryOf = (policy: MaybeOwn): PrivacyDictionaryPolicy => policy?.dictionary ?? { off: [], lists: [] };
export const rulesOf = (policy: MaybeOwn): readonly PrivacyRule[] => policy?.rules ?? [];

// An id for a new list or rule, stable for its life, so renaming one never confuses it with another.
export const mintId = (prefix: `list` | `rule`, taken: readonly { readonly id: string }[]): string => {
    const ids = new Set(taken.map((each) => each.id));
    let id = `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
    while (ids.has(id)) {
        id = `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
    }
    return id;
};

// The item in place of the one with its id, or added at the end.
const upserted = <T extends { readonly id: string }>(items: readonly T[], item: T): T[] => {
    const at = items.findIndex((each) => each.id === item.id);
    return at === -1 ? [...items, item] : items.with(at, item);
};

// The item put back where it stood, unless it has come back some other way meanwhile.
const restored = <T extends { readonly id: string }>(items: readonly T[], item: T, index: number): T[] =>
    items.some((each) => each.id === item.id) ? [...items] : items.toSpliced(Math.min(index, items.length), 0, item);

const withDictionary = (
    policy: PrivacyShieldPolicy,
    change: (dictionary: PrivacyDictionaryPolicy) => PrivacyDictionaryPolicy,
): PrivacyShieldPolicy => ({
    ...policy,
    dictionary: change(dictionaryOf(policy)),
});

// A built-in list switched on or off; ids stay in the order they were switched off.
export const withListOn = (policy: PrivacyShieldPolicy, id: string, on: boolean): PrivacyShieldPolicy =>
    withDictionary(policy, (dictionary) => {
        const others = dictionary.off.filter((each) => each !== id);
        return { ...dictionary, off: on ? others : [...others, id] };
    });

export const withOwnList = (policy: PrivacyShieldPolicy, list: PrivacyOwnNameList): PrivacyShieldPolicy =>
    withDictionary(policy, (dictionary) => ({ ...dictionary, lists: upserted(dictionary.lists, list) }));

export const withoutOwnList = (policy: PrivacyShieldPolicy, id: string): PrivacyShieldPolicy =>
    withDictionary(policy, (dictionary) => ({ ...dictionary, lists: dictionary.lists.filter((each) => each.id !== id) }));

export const withOwnListBack = (policy: PrivacyShieldPolicy, list: PrivacyOwnNameList, index: number): PrivacyShieldPolicy =>
    withDictionary(policy, (dictionary) => ({ ...dictionary, lists: restored(dictionary.lists, list, index) }));

export const withRule = (policy: PrivacyShieldPolicy, rule: PrivacyRule): PrivacyShieldPolicy => ({
    ...policy,
    rules: upserted(rulesOf(policy), rule),
});

export const withoutRule = (policy: PrivacyShieldPolicy, id: string): PrivacyShieldPolicy => ({
    ...policy,
    rules: rulesOf(policy).filter((each) => each.id !== id),
});

export const withRuleBack = (policy: PrivacyShieldPolicy, rule: PrivacyRule, index: number): PrivacyShieldPolicy => ({
    ...policy,
    rules: restored(rulesOf(policy), rule, index),
});

export const newOwnList = (id: string, title: string): PrivacyOwnNameList => ({
    id,
    title,
    kind: `first-name`,
    matching: `as-written`,
    words: [],
    on: true,
});

export const newRule = (id: string, title: string): PrivacyRule => ({
    id,
    title,
    on: true,
    class: `person-name`,
    match: `terms`,
    terms: [],
    pattern: ``,
    matchCase: false,
});

// Why a rule cannot be saved as it stands: no title, nothing to match, or a pattern the daemon would refuse. A pattern
// already saved is the daemon's to keep (it judges only new ones), so it is not judged again here.
export type RuleProblem = `noTitle` | `noTerms` | PrivacyPatternProblem;

export const ruleProblem = (rule: PrivacyRule, saved?: PrivacyRule): RuleProblem | undefined => {
    if (rule.title.trim() === ``) {
        return `noTitle`;
    }
    if (rule.match === `terms`) {
        return rule.terms.length === 0 ? `noTerms` : undefined;
    }
    return saved?.match === `pattern` && saved.pattern === rule.pattern ? undefined : patternProblem(rule.pattern);
};

// Only the kinds of list where Polish inflection means anything offer it: first names and surnames.
export const inflects = (list: Pick<PrivacyOwnNameList, `kind`>): boolean => list.kind === `first-name` || list.kind === `surname`;
