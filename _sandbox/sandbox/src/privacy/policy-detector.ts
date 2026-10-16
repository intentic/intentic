import type { PersonalDataClass, PrivacyDictionaryPolicy, PrivacyRule, PrivacyShieldPolicy } from "@intentic/sandbox-contract/schemas/privacy";
import { detectPersonalData, normalizeAllowed, type PersonalDataSpan } from "@intentic/privacy-detect";
import { createLexicon, type Lexicon } from "@intentic/privacy-detect/lexicon";
import { createKnownMatcher, type KnownMatcher, type Spelling } from "./known-matcher.js";

// The detectors as the owner set them: the built-in ones over the name lists they left on and added, and their own
// rules (privacy policy `dictionary` and `rules`). Everything that finds personal data for the shield reads through one
// of these, so a list switched off or a rule added holds alike for the gateway, a hooked runtime's channels, a push and
// a share. Built once per configuration and kept while it is in force: a lexicon and a matcher over a few thousand terms
// cost milliseconds, a policy is read on every request.

// One find, and the owner's rule that made it when one did.
export interface PolicySpan extends PersonalDataSpan {
    readonly rule?: string;
}

export interface PolicyDetector {
    // Identifies what this detector finds, for memo keys: two policies with the same key find the same.
    readonly key: string;
    readonly lexicon: Lexicon;
    readonly classes: ReadonlySet<PersonalDataClass>;
    readonly allow: ReadonlySet<string>;
    // Sorted by start and non-overlapping; where a rule and a detector find the same stretch, the detector's stands.
    readonly detect: (text: string) => PolicySpan[];
}

export type DetectorPolicy = Pick<PrivacyShieldPolicy, "classes" | "allow" | "dictionary" | "rules">;

// A pattern that matches this often in one string is matching nearly everything, and is cut off there rather than
// costing a turn: the rest of the string is left to the other detectors.
const PATTERN_MATCHES_MAX = 10_000;

interface CompiledPattern {
    readonly rule: PrivacyRule;
    readonly regex: RegExp;
    // Masks only the group named `value`, when the pattern has one.
    readonly group: boolean;
}

// A term's spelling as the vault spells a value (privacy-vault.ts spellingOf): one plain word as written or in any case,
// one with a digit or several words with its separators anywhere or nowhere.
const termSpelling = (term: string, matchCase: boolean): Spelling => {
    if (matchCase) {
        return "exact";
    }
    return /\p{N}/u.test(term) || (term.match(/[\p{L}\p{N}]+/gu) ?? []).length > 1 ? "folded" : "case";
};

const VALUE_GROUP = /\(\?<value>/u;

const compilePattern = (rule: PrivacyRule, warn: (message: string) => void): CompiledPattern | undefined => {
    const group = VALUE_GROUP.test(rule.pattern);
    try {
        return { rule, regex: new RegExp(rule.pattern, `g${rule.matchCase ? "" : "i"}u${group ? "d" : ""}`), group };
    } catch (error) {
        // Saved through the route, a pattern compiles; one written into the file by hand that does not is left out
        // rather than taking the shield down with it.
        warn(`privacy: the rule "${rule.title}" has a pattern that does not compile, so it masks nothing: ${String(error)}`);
        return undefined;
    }
};

const patternSpans = ({ rule, regex, group }: CompiledPattern, text: string, emit: (start: number, end: number, rule: PrivacyRule) => void): void => {
    regex.lastIndex = 0;
    let count = 0;
    for (let match = regex.exec(text); match !== null && count < PATTERN_MATCHES_MAX; match = regex.exec(text)) {
        if (match[0] === "") {
            regex.lastIndex += 1;
            continue;
        }
        count += 1;
        const [start, end] = group ? (match.indices?.groups?.["value"] ?? [match.index, match.index]) : [match.index, match.index + match[0].length];
        if (end > start) {
            emit(start, end, rule);
        }
    }
};

// Detector finds first, so on a tie of length and class the detector's span (no rule) is the one kept: a value the
// detectors would find anyway is theirs, and the vault goes on matching it after the rule is switched off.
const merge = (detected: readonly PolicySpan[], ruled: readonly PolicySpan[]): PolicySpan[] => {
    if (ruled.length === 0) {
        return [...detected];
    }
    const all = [...detected, ...ruled].toSorted((left, right) => left.start - right.start || right.end - right.start - (left.end - left.start));
    const kept: PolicySpan[] = [];
    let covered = 0;
    for (const span of all) {
        if (span.start >= covered) {
            kept.push(span);
            covered = span.end;
        }
    }
    return kept;
};

// The lexicon the name rules read under the owner's dictionary: the built-in lists less those switched off, and their
// own lists that are on.
export const dictionaryLexicon = (config: PrivacyDictionaryPolicy): Lexicon =>
    createLexicon({ off: config.off, own: config.lists.filter((list) => list.on) });

const buildDetector = (policy: DetectorPolicy, key: string, warn: (message: string) => void): PolicyDetector => {
    const classes = new Set<PersonalDataClass>(policy.classes);
    const allow = new Set(policy.allow.map(normalizeAllowed));
    const lexicon = dictionaryLexicon(policy.dictionary);
    // A rule counts as the kind it masks as: switching that kind off stops it too.
    const rules = policy.rules.filter((rule) => rule.on && classes.has(rule.class));
    const terms: KnownMatcher<PrivacyRule> = createKnownMatcher(
        rules
            .filter((rule) => rule.match === "terms")
            .flatMap((rule) =>
                rule.terms
                    .map((term) => term.trim())
                    .filter((term) => term !== "")
                    .map((term) => ({ value: term, payload: rule, spelling: termSpelling(term, rule.matchCase) })),
            ),
    );
    const patterns = rules.filter((rule) => rule.match === "pattern" && rule.pattern !== "").flatMap((rule) => compilePattern(rule, warn) ?? []);
    return {
        key,
        lexicon,
        classes,
        allow,
        detect: (text) => {
            const detected = detectPersonalData(text, { classes, allow, lexicon });
            const ruled: PolicySpan[] = [];
            const emit = (start: number, end: number, rule: PrivacyRule): void => {
                const value = text.slice(start, end);
                if (!allow.has(normalizeAllowed(value))) {
                    ruled.push({ start, end, class: rule.class, value, rule: rule.id });
                }
            };
            for (const hit of terms.find(text)) {
                emit(hit.start, hit.end, hit.payload);
            }
            for (const pattern of patterns) {
                patternSpans(pattern, text, emit);
            }
            return merge(detected, ruled);
        },
    };
};

// The key of what a policy has the detectors find: everything else in it (trust, images, the mode) changes nothing here.
const detectorKey = (policy: DetectorPolicy): string =>
    JSON.stringify([
        [...policy.classes].toSorted(),
        [...new Set(policy.allow.map(normalizeAllowed))].toSorted(),
        policy.dictionary.off.toSorted(),
        policy.dictionary.lists.filter((list) => list.on).map((list) => [list.kind, list.matching, list.words]),
        policy.rules
            .filter((rule) => rule.on)
            .map((rule) => [rule.id, rule.class, rule.match, rule.match === "terms" ? rule.terms : rule.pattern, rule.matchCase]),
    ]);

// The few configurations in force lately: the policy in force, and the one before it while requests that read it finish.
const KEPT = 4;
const kept = new Map<string, PolicyDetector>();

export const detectorFor = (policy: DetectorPolicy, warn: (message: string) => void = () => undefined): PolicyDetector => {
    const key = detectorKey(policy);
    const found = kept.get(key);
    if (found !== undefined) {
        kept.delete(key);
        kept.set(key, found);
        return found;
    }
    const detector = buildDetector(policy, key, warn);
    kept.set(key, detector);
    for (const oldest of kept.keys()) {
        if (kept.size <= KEPT) {
            break;
        }
        kept.delete(oldest);
    }
    return detector;
};
