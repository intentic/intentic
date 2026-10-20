import { allowKey, type PersonalDataClass } from "@intentic/sandbox-contract/schemas/privacy";
import { findAddresses } from "./address.js";
import { findEmails, findPhones } from "./contact.js";
import { findBankAccounts, findIdentityDocuments, findNip, findPaymentCards, findPesel } from "./identifiers.js";
import { builtInLexicon, type Lexicon } from "./lexicon.js";
import { findNames } from "./names.js";
import { type Candidate, resolveSpans, type SpanSource } from "./spans.js";
import { standsAlone } from "./standalone.js";
import type { Emit } from "./text.js";

// The detector: personal data in arbitrary text (tool output, database dumps, CSV, JSON, prose, code, mail), found
// synchronously and in one pass per kind, so the gateway can mask a request without waiting on anything. Every value
// it masks is put back in the response, so a false find costs the model a little understanding while a missed one
// leaks; the rules lean to finding, except in code, where identifiers must stay readable.

export type { Candidate, PersonalDataSpan, SpanSource } from "./spans.js";
export { resolveSpans } from "./spans.js";

export interface DetectOptions {
    readonly classes: ReadonlySet<PersonalDataClass>;
    // Values never reported, as allowKey reads them.
    readonly allow?: ReadonlySet<string>;
    // The name lists as the owner set them (createLexicon); the built-in ones when absent.
    readonly lexicon?: Lexicon;
}

const DETECTORS: ReadonlyArray<readonly [PersonalDataClass, (text: string, emit: Emit, lexicon?: Lexicon) => void]> = [
    ["national-id", findPesel],
    ["tax-id", findNip],
    ["identity-document", findIdentityDocuments],
    ["bank-account", findBankAccounts],
    ["payment-card", findPaymentCards],
    ["email", findEmails],
    ["phone", findPhones],
    ["address", findAddresses],
    ["person-name", findNames],
];

// What the built-in detectors propose in a text, each read in its own context; not yet settled, for a caller that adds
// candidates of other sources before the gate.
export const detectorCandidates = (text: string, options: Pick<DetectOptions, "classes" | "lexicon">): Candidate[] => {
    const found: Candidate[] = [];
    if (text === "") {
        return found;
    }
    for (const [kind, detect] of DETECTORS) {
        if (options.classes.has(kind)) {
            detect(text, (start, end, emitted) => found.push({ start, end, class: emitted, value: text.slice(start, end), by: "detector" }), options.lexicon);
        }
    }
    return found;
};

// What a candidate brings for itself: a detector read it in context, and a rule or a taught value is the owner's own
// word. A learned value and a model's guess bring nothing of the place they stand in, so they are asked standsAlone.
const SELF_EVIDENT: ReadonlySet<SpanSource> = new Set<SpanSource>(["detector", "rule", "taught"]);

// THE PIPELINE'S ONE GATE. Every source proposes candidates (the detectors, the owner's rules, the vault, the name
// model) and every one passes here before anything is masked: its kind is looked for, it is not a value the owner never
// masks, and its evidence holds where it stands. Then overlaps are settled once, by one ranking. The gateway, a hooked
// runtime's channels, a sealed prompt, a push and a share all mask through it, so a find it refuses is refused for all.
export interface Gate {
    readonly admits: (text: string, candidate: Candidate) => boolean;
    readonly settle: <T extends Candidate>(text: string, candidates: readonly T[]) => T[];
}

export const createGate = ({ classes, allow, lexicon = builtInLexicon() }: DetectOptions): Gate => {
    const admits = (text: string, candidate: Candidate): boolean =>
        classes.has(candidate.class) &&
        (allow === undefined || allow.size === 0 || !allow.has(allowKey(candidate.value))) &&
        (SELF_EVIDENT.has(candidate.by) || standsAlone(candidate.class, text, candidate.start, candidate.end, lexicon));
    return { admits, settle: (text, candidates) => resolveSpans(candidates.filter((candidate) => admits(text, candidate))) };
};

// Sorted by start and non-overlapping: on overlap the longer is kept, on a tie the more specific class (checksummed
// identifiers, then e-mail and phone, then address, then name).
export const detectPersonalData = (text: string, options: DetectOptions): Candidate[] =>
    options.classes.size === 0 ? [] : createGate(options).settle(text, detectorCandidates(text, options));
