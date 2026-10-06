import { createHash } from "node:crypto";
import { PRIVACY_EXCERPT_REACH, type PersonalDataClass, type PrivacyReplacement, type PrivacyShieldPolicy } from "@intentic/sandbox-contract";
import { detectPersonalData, normalizeAllowed, type PersonalDataSpan } from "./detect/detect.js";
import type { PrivacyVault, VaultHit } from "./privacy-vault.js";
import { LITERAL_PREFIX, TOKEN_LABEL, TOKEN_SOURCE, tokenPattern } from "./tokens.js";

// One string bound for an untrusted provider, masked: every value the vault already holds, then whatever the detectors
// (and the local name model, where installed) find, each replaced by its token. A request re-sends its whole
// conversation every time, so almost every string has been masked before: the memo answers those by hash, which is what
// keeps the cost of a turn proportional to what it added, and keeps the masked bytes identical between requests.

export type ClassCounts = Partial<Record<PersonalDataClass, number>>;

// One value replaced, as the log keeps it: its token, its kind, and the masked text around it.
export type Replacement = Omit<PrivacyReplacement, "image">;

export interface MaskResult {
    readonly text: string;
    // What was found in a string not seen before; empty for one the memo answered, so a request counts only what it
    // added.
    readonly counts: ClassCounts;
    // Each value counted, in the order it sits in the string; empty exactly when `counts` is.
    readonly found: readonly Replacement[];
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
    readonly find: (
        text: string,
    ) => Promise<{ readonly spans: readonly FoundSpan[]; readonly counts: ClassCounts; readonly found: readonly Replacement[] }>;
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

// Labels a token can be restored by, and the escaped ones, whose prefix restoring takes off.
const RESTORABLE_LABELS: ReadonlySet<string> = new Set(Object.values(TOKEN_LABEL));
const restorable = (label: string): boolean => RESTORABLE_LABELS.has(label) || label.startsWith(LITERAL_PREFIX);

// A token-shaped literal in what a request carries, as the provider is sent it: escaped (tokens.ts, LITERAL_PREFIX) when
// restoring could otherwise read it, else exactly as it was, since nothing would ever resolve it.
const WHOLE_TOKEN = new RegExp(`^(?:${TOKEN_SOURCE})$`, "u");
const escapedLiteral = (token: string): string => {
    const [, label, , looseLabel] = WHOLE_TOKEN.exec(token) ?? [];
    const open = label === undefined ? "[[" : "⟦";
    return restorable(label ?? looseLabel ?? "") ? `${open}${LITERAL_PREFIX}${token.slice(open.length)}` : token;
};

// Token-shaped text already in a string is data: a runtime holds only what the gateway restored, so it was never given
// out for what it stands beside. Nothing is looked for inside it, and the first masking escapes it (escapedLiteral).
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

// Where a token landed in a masked string.
interface Placed {
    readonly token: string;
    readonly class: PersonalDataClass;
    readonly at: number;
}

const WHITESPACE = /\s/u;

// The masked text around one token, on one line: cut at whitespace where there is some within reach, so neither a word
// nor another token is cut in half, and marked with an ellipsis where the string goes on.
export const excerptAround = (text: string, start: number, end: number, reach = PRIVACY_EXCERPT_REACH): string => {
    let from = Math.max(0, start - reach);
    let to = Math.min(text.length, end + reach);
    // Mid-word on the left: start after the next whitespace instead.
    if (from > 0 && !WHITESPACE.test(text[from - 1] ?? "")) {
        const space = text.slice(from, start).search(WHITESPACE);
        from = space === -1 ? from : from + space + 1;
    }
    // Mid-word on the right: end at the last whitespace instead.
    if (to < text.length && !WHITESPACE.test(text[to] ?? "")) {
        const tail = text.slice(end, to);
        const space = Math.max(...[" ", "\n", "\t", "\r"].map((each) => tail.lastIndexOf(each)));
        to = space === -1 ? to : end + space;
    }
    const body = text.slice(from, to).replace(/\s+/gu, " ").trim();
    return `${from > 0 ? "…" : ""}${body}${to < text.length ? "…" : ""}`;
};

const replacementsIn = (masked: string, placed: readonly Placed[]): Replacement[] =>
    placed.map((each) => ({ token: each.token, class: each.class, excerpt: excerptAround(masked, each.at, each.at + each.token.length) }));

// The text with each span replaced by its token, and where each token landed, offset by `base`.
const placeTokens = (
    text: string,
    spans: readonly { readonly start: number; readonly end: number; readonly class: PersonalDataClass; readonly token: string }[],
    placed: Placed[],
    base: number,
): string => {
    let out = "";
    let last = 0;
    for (const span of spans) {
        out += text.slice(last, span.start);
        placed.push({ token: span.token, class: span.class, at: base + out.length });
        out += span.token;
        last = span.end;
    }
    return out + text.slice(last);
};

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

    // Replaces the chosen spans; tallies what it replaced, and where each token landed in the whole string (`base` is
    // where this stretch starts in it).
    const apply = (text: string, spans: readonly Candidate[], counts: Record<string, number>, placed: Placed[], base: number): string => {
        for (const span of spans) {
            counts[span.class] = (counts[span.class] ?? 0) + 1;
        }
        return placeTokens(
            text,
            spans.map((span) => ({ ...span, token: span.token ?? vault.tokenFor(span.value, span.class) })),
            placed,
            base,
        );
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

    // Only the vault's values can have changed since a remembered masking; looking for those alone is a fraction of the
    // full pass.
    const remaskKnown = (text: string, counts: Record<string, number>, placed: Placed[]): string => {
        let out = "";
        for (const part of segmentsAroundTokens(text)) {
            out += part.token ? part.text : apply(part.text, chooseSpans(knownCandidates(part.text)), counts, placed, out.length);
        }
        return out;
    };

    return {
        mask: async (text) => {
            if (text.length < 2 || !HAS_WORD.test(text)) {
                return { text, counts: {}, found: [] };
            }
            await vault.load();
            const key = createHash("sha1").update(policyKey).update("\0").update(text).digest("base64url");
            const remembered = memo.get(key);
            if (remembered !== undefined && remembered.generation === vault.generation()) {
                return { text: remembered.text, counts: {}, found: [] };
            }
            const counts: Record<string, number> = {};
            const placed: Placed[] = [];
            let masked = "";
            if (remembered === undefined) {
                for (const part of segmentsAroundTokens(text)) {
                    masked += part.token ? escapedLiteral(part.text) : apply(part.text, await spansOf(part.text), counts, placed, masked.length);
                }
            } else {
                masked = remaskKnown(remembered.text, counts, placed);
            }
            // The generation after this masking's own additions: they are in `masked` already.
            memo.set(key, { text: masked, generation: vault.generation() });
            return { text: masked, counts, found: replacementsIn(masked, placed) };
        },
        find: async (text) => {
            const counts: Record<string, number> = {};
            if (text.length < 2 || !HAS_WORD.test(text)) {
                return { spans: [], counts, found: [] };
            }
            await vault.load();
            // Remembered as the masked strings are, under a key of its own: an image's words are re-sent with every
            // request of a conversation, and only the vault's values can change what they hold.
            const key = createHash("sha1").update("find\0").update(policyKey).update("\0").update(text).digest("base64url");
            const remembered = memo.get(key);
            if (remembered !== undefined && remembered.generation === vault.generation()) {
                return { spans: parseSpans(remembered.text), counts: {}, found: [] };
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
            if (remembered !== undefined) {
                return { spans, counts, found: [] };
            }
            // The words as the picture reads once painted over: the same spans, each written as its token.
            const placed: Placed[] = [];
            const masked = placeTokens(text, spans, placed, 0);
            return { spans, counts, found: replacementsIn(masked, placed) };
        },
        restore: (text) =>
            text.includes("⟦") || text.includes("[[")
                ? text.replace(tokenPattern(), (whole, label?: string, index?: string, looseLabel?: string, looseIndex?: string) => {
                      // An escaped literal comes back as the literal it was: one prefix off, whatever follows it.
                      if ((label ?? looseLabel ?? "").startsWith(LITERAL_PREFIX)) {
                          return whole.replace(LITERAL_PREFIX, "");
                      }
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
