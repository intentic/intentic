import type { PersonalDataClass } from "@intentic/sandbox-contract";
import { findAddresses } from "./address.js";
import { findEmails, findPhones } from "./contact.js";
import { findBankAccounts, findIdentityDocuments, findNip, findPaymentCards, findPesel } from "./identifiers.js";
import { findNames } from "./names.js";
import { type PersonalDataSpan, resolveSpans } from "./spans.js";
import type { Emit } from "./text.js";

// The detector: personal data in arbitrary text (tool output, database dumps, CSV, JSON, prose, code, mail), found
// synchronously and in one pass per kind, so the gateway can mask a request without waiting on anything. Every value
// it masks is put back in the response, so a false find costs the model a little understanding while a missed one
// leaks; the rules lean to finding, except in code, where identifiers must stay readable.

export type { PersonalDataSpan } from "./spans.js";

export interface DetectOptions {
    readonly classes: ReadonlySet<PersonalDataClass>;
    // Values never reported, already normalized with normalizeAllowed.
    readonly allow?: ReadonlySet<string>;
}

// How allowlist entries and found values are compared: case, Unicode composition and spacing do not matter.
export const normalizeAllowed = (value: string): string => value.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();

const DETECTORS: ReadonlyArray<readonly [PersonalDataClass, (text: string, emit: Emit) => void]> = [
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

// Spans sorted by start and non-overlapping: on overlap the longer is kept, on a tie the more specific class
// (checksummed identifiers, then e-mail and phone, then address, then name).
export const detectPersonalData = (text: string, options: DetectOptions): PersonalDataSpan[] => {
    if (text === "" || options.classes.size === 0) {
        return [];
    }
    const found: PersonalDataSpan[] = [];
    const allow = options.allow;
    const emit: Emit = (start, end, kind) => {
        const value = text.slice(start, end);
        if (options.classes.has(kind) && (allow === undefined || allow.size === 0 || !allow.has(normalizeAllowed(value)))) {
            found.push({ start, end, class: kind, value });
        }
    };
    for (const [kind, detect] of DETECTORS) {
        if (options.classes.has(kind)) {
            detect(text, emit);
        }
    }
    return resolveSpans(found);
};

// Spans from another source (the local named-entity model) merged into the detector's, under the same overlap rule.
export const mergeSpans = (a: readonly PersonalDataSpan[], b: readonly PersonalDataSpan[]): PersonalDataSpan[] => resolveSpans([...a, ...b]);
