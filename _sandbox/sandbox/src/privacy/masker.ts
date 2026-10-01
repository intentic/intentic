import { createHash } from "node:crypto";
import type { PersonalDataClass, PrivacyShieldPolicy } from "@intentic/sandbox-contract";
import { detectPersonalData, normalizeAllowed, type PersonalDataSpan } from "./detect/detect.js";
import type { PrivacyVault, VaultHit } from "./privacy-vault.js";
import { tokenPattern } from "./tokens.js";

// One string bound for an untrusted provider, masked: every value the vault already holds, then whatever the detectors
// (and the local name model, where installed) find, each replaced by its token. A request re-sends its whole
// conversation every time, so almost every string has been masked before: the memo answers those by hash, which is what
// keeps the cost of a turn proportional to what it added, and keeps the masked bytes identical between requests.

export type ClassCounts = Partial<Record<PersonalDataClass, number>>;

export interface MaskResult {
    readonly text: string;
    // What was found in a string not seen before; empty for one the memo answered, so a request counts only what it
    // added.
    readonly counts: ClassCounts;
}

// A second source of spans: the local named-entity model.
export interface EntityRecognizer {
    readonly find: (text: string) => Promise<readonly PersonalDataSpan[]>;
}

// One value found in a string, where it sits, and the token it was given.
export interface FoundSpan {
    readonly start: number;
    readonly end: number;
    readonly class: PersonalDataClass;
    readonly token: string;
}

export interface Masker {
    readonly mask: (text: string) => Promise<MaskResult>;
    // Where the personal data in a string sits and the token each value was given, the string left as it is: for text
    // that exists only as pixels (an image's words), where what changes is the picture. Counts as `mask` counts.
    readonly find: (text: string) => Promise<{ readonly spans: readonly FoundSpan[]; readonly counts: ClassCounts }>;
    readonly restore: (text: string) => string;
}

interface Remembered {
    readonly text: string;
    readonly generation: number;
}

// Masked strings by hash of policy and input, oldest dropped first once the total passes the budget.
export interface MaskMemo {
    readonly get: (key: string) => Remembered | undefined;
    readonly set: (key: string, value: Remembered) => void;
}

// Enough for the transcripts of a few busy conversations; a miss only costs a detector pass.
const MEMO_BUDGET_CHARS = 48_000_000;

export const createMaskMemo = (budget = MEMO_BUDGET_CHARS): MaskMemo => {
    const entries = new Map<string, Remembered>();
    let size = 0;
    return {
        get: (key) => {
            const hit = entries.get(key);
            if (hit !== undefined) {
                // Re-inserted, so the order of the map is the order of last use.
                entries.delete(key);
                entries.set(key, hit);
            }
            return hit;
        },
        set: (key, value) => {
            const previous = entries.get(key);
            if (previous !== undefined) {
                size -= previous.text.length;
                entries.delete(key);
            }
            entries.set(key, value);
            size += value.text.length;
            for (const [oldest, entry] of entries) {
                if (size <= budget) {
                    break;
                }
                entries.delete(oldest);
                size -= entry.text.length;
            }
        },
    };
};

interface Candidate {
    readonly start: number;
    readonly end: number;
    readonly class: PersonalDataClass;
    readonly value: string;
    // Known values carry the token they already have; found ones are given one.
    readonly token?: string;
    // Lower wins a tie: what the vault knows, then the detectors, then the model.
    readonly rank: number;
}

// Leftmost first; at one place the longer span, then the better-ranked source.
const chooseSpans = (candidates: readonly Candidate[]): Candidate[] => {
    const sorted = candidates.toSorted(
        (left, right) => left.start - right.start || right.end - right.start - (left.end - left.start) || left.rank - right.rank,
    );
    const chosen: Candidate[] = [];
    let covered = 0;
    for (const candidate of sorted) {
        if (candidate.start >= covered) {
            chosen.push(candidate);
            covered = candidate.end;
        }
    }
    return chosen;
};

// Tokens already in a string (the model's own words, re-sent) are left exactly as they are and nothing is looked for
// inside them.
const segmentsAroundTokens = (text: string): { readonly text: string; readonly token: boolean }[] => {
    const parts: { text: string; token: boolean }[] = [];
    let last = 0;
    for (const match of text.matchAll(tokenPattern())) {
        if (match.index > last) {
            parts.push({ text: text.slice(last, match.index), token: false });
        }
        parts.push({ text: match[0], token: true });
        last = match.index + match[0].length;
    }
    if (last < text.length) {
        parts.push({ text: text.slice(last), token: false });
    }
    return parts;
};

const HAS_WORD = /[\p{L}\p{N}]/u;

// Spans as `find` remembers them, written by itself; anything else reads as nothing found.
const parseSpans = (text: string): FoundSpan[] => {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.filter((span): span is FoundSpan => typeof span === "object" && span !== null && "token" in span) : [];
};

export interface MaskerDeps {
    readonly vault: PrivacyVault;
    readonly policy: Pick<PrivacyShieldPolicy, "classes" | "allow" | "names">;
    readonly memo: MaskMemo;
    readonly recognizer?: EntityRecognizer | undefined;
}

export const createMasker = ({ vault, policy, memo, recognizer }: MaskerDeps): Masker => {
    const classes = new Set<PersonalDataClass>(policy.classes);
    const allow = new Set(policy.allow.map(normalizeAllowed));
    const policyKey = JSON.stringify([[...classes].toSorted(), [...allow].toSorted(), recognizer === undefined ? "dictionary" : policy.names]);
    const admitted = (kind: PersonalDataClass, value: string): boolean => classes.has(kind) && !allow.has(normalizeAllowed(value));

    const knownCandidates = (text: string): Candidate[] =>
        vault
            .matcher()
            .find(text)
            .flatMap(({ start, end, payload }: { start: number; end: number; payload: VaultHit }) => {
                const value = text.slice(start, end);
                return admitted(payload.class, value) ? [{ start, end, class: payload.class, value, token: payload.token, rank: 0 }] : [];
            });

    // Replaces the chosen spans; tallies what it replaced.
    const apply = (text: string, spans: readonly Candidate[], counts: Record<string, number>): string => {
        let out = "";
        let last = 0;
        for (const span of spans) {
            out += text.slice(last, span.start) + (span.token ?? vault.tokenFor(span.value, span.class));
            last = span.end;
            counts[span.class] = (counts[span.class] ?? 0) + 1;
        }
        return out + text.slice(last);
    };

    // What every source finds in a stretch of text holding no token, overlaps settled.
    const spansOf = async (text: string): Promise<Candidate[]> => {
        if (!HAS_WORD.test(text)) {
            return [];
        }
        const detected: Candidate[] = detectPersonalData(text, { classes, allow }).map((span) => ({ ...span, rank: 1 }));
        const recognized: Candidate[] =
            recognizer === undefined
                ? []
                : (await recognizer.find(text)).filter((span) => admitted(span.class, span.value)).map((span) => ({ ...span, rank: 2 }));
        return chooseSpans([...knownCandidates(text), ...detected, ...recognized]);
    };

    const maskSegment = async (text: string, counts: Record<string, number>): Promise<string> => apply(text, await spansOf(text), counts);

    // Only the vault's values can have changed since a remembered masking; looking for those alone is a fraction of the
    // full pass.
    const remaskKnown = (text: string, counts: Record<string, number>): string =>
        segmentsAroundTokens(text)
            .map((part) => (part.token ? part.text : apply(part.text, chooseSpans(knownCandidates(part.text)), counts)))
            .join("");

    return {
        mask: async (text) => {
            if (text.length < 2 || !HAS_WORD.test(text)) {
                return { text, counts: {} };
            }
            await vault.load();
            const key = createHash("sha1").update(policyKey).update("\0").update(text).digest("base64url");
            const remembered = memo.get(key);
            if (remembered !== undefined && remembered.generation === vault.generation()) {
                return { text: remembered.text, counts: {} };
            }
            const counts: Record<string, number> = {};
            let masked: string;
            if (remembered === undefined) {
                const parts: string[] = [];
                for (const part of segmentsAroundTokens(text)) {
                    parts.push(part.token ? part.text : await maskSegment(part.text, counts));
                }
                masked = parts.join("");
            } else {
                masked = remaskKnown(remembered.text, counts);
            }
            // The generation after this masking's own additions: they are in `masked` already.
            memo.set(key, { text: masked, generation: vault.generation() });
            return { text: masked, counts };
        },
        find: async (text) => {
            const counts: Record<string, number> = {};
            if (text.length < 2 || !HAS_WORD.test(text)) {
                return { spans: [], counts };
            }
            await vault.load();
            // Remembered as the masked strings are, under a key of its own: an image's words are re-sent with every
            // request of a conversation, and only the vault's values can change what they hold.
            const key = createHash("sha1").update("find\0").update(policyKey).update("\0").update(text).digest("base64url");
            const remembered = memo.get(key);
            if (remembered !== undefined && remembered.generation === vault.generation()) {
                return { spans: parseSpans(remembered.text), counts: {} };
            }
            const spans: FoundSpan[] = [];
            let offset = 0;
            for (const part of segmentsAroundTokens(text)) {
                if (!part.token) {
                    for (const span of await spansOf(part.text)) {
                        spans.push({
                            start: offset + span.start,
                            end: offset + span.end,
                            class: span.class,
                            token: span.token ?? vault.tokenFor(span.value, span.class),
                        });
                        // A string seen before counts nothing again, as with `mask`.
                        if (remembered === undefined) {
                            counts[span.class] = (counts[span.class] ?? 0) + 1;
                        }
                    }
                }
                offset += part.text.length;
            }
            memo.set(key, { text: JSON.stringify(spans), generation: vault.generation() });
            return { spans, counts };
        },
        restore: (text) =>
            text.includes("⟦") || text.includes("[[")
                ? text.replace(tokenPattern(), (whole, label?: string, index?: string, looseLabel?: string, looseIndex?: string) => {
                      const resolved =
                          label !== undefined && index !== undefined
                              ? vault.resolve(label, index)
                              : looseLabel !== undefined && looseIndex !== undefined
                                ? vault.resolve(looseLabel, looseIndex)
                                : undefined;
                      return resolved ?? whole;
                  })
                : text,
    };
};
