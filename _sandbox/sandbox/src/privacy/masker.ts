import { createHash } from "node:crypto";
import {
    PRIVACY_EXCERPT_REACH,
    type PersonalDataClass,
    type PrivacyPreviewSpan,
    type PrivacyReplacement,
    type PrivacyShieldPolicy,
} from "@intentic/sandbox-contract/schemas/privacy";
import type { Gate, PersonalDataSpan } from "@intentic/privacy-detect";
import { detectorFor, type PolicyDetector, type PolicySpan } from "./policy-detector.js";
import { opt } from "../opt.js";
import type { PrivacyVault, VaultHit } from "./privacy-vault.js";
import { LITERAL_PREFIX, TOKEN_LABEL, TOKEN_SOURCE, tokenKey, tokenPattern } from "./tokens.js";

// One string bound for an untrusted provider, masked: what the vault already holds, the detectors and the owner's rules
// find, and the local name model (where installed) reads, each proposed to the one gate (@intentic/privacy-detect
// createGate) and each it keeps replaced by its token. A request re-sends its whole
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

// A source of candidates the detectors do not read: the local named-entity model, its guesses held at the gate to what
// a name or an address is alone.
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

// Which tokens a restore may read back: those the provider was given in the request it is answering, by their key
// (`PERSON_3`). Any other token the model writes it made up, and it is left as written.
export interface RestoreScope {
    readonly given: (key: string) => boolean;
    // Told of each token the model made up, as written.
    readonly coined?: (token: string) => void;
}

export interface Masker {
    readonly mask: (text: string) => Promise<MaskResult>;
    // A string the provider itself wrote (its replies, the calls it made), masked for sending back to it. Its own words
    // are its own: nothing in them is given a new token, so a name it made up goes back as it wrote it, and does not
    // become personal data of the owner's. What the vault already holds goes back as its token, since the model wrote it
    // only because a token was restored, and so does anything found around such a value.
    readonly own: (text: string) => Promise<MaskResult>;
    // Where the personal data in a string sits and the token each value was given, the string left as it is: for text
    // that exists only as pixels (an image's words), where what changes is the picture. Counts as `mask` counts.
    // `keep` picks the finds that count from all of them, for a text that holds some words twice (an image's wrapped
    // lines read again joined, image-mask.ts distinctFinds): what it leaves out is neither answered nor counted.
    readonly find: (
        text: string,
        keep?: (spans: readonly FoundSpan[]) => readonly FoundSpan[],
    ) => Promise<{ readonly spans: readonly FoundSpan[]; readonly counts: ClassCounts; readonly found: readonly Replacement[] }>;
    readonly restore: (text: string) => string;
    // The same, reading back only the tokens `scope` says the provider was given.
    readonly restoreGiven: (text: string, scope: RestoreScope) => string;
    // What every source would find in a string and which found it, for the owner trying the shield on a text: nothing
    // is given a token, nothing is remembered, and the vault is only read.
    readonly inspect: (text: string) => Promise<PrivacyPreviewSpan[]>;
    // The values the vault already holds in a string, as the gate admits them where they stand, and the token each one
    // goes to a provider as. Only read: no detector runs, no token is given and nothing is marked seen. For a reply that
    // was written as tokens and restored here, these are the words its model never read.
    readonly known: (text: string) => Promise<readonly FoundSpan[]>;
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

// One candidate on its way to a token: the vault's carry the one they already have.
interface Proposed extends PolicySpan {
    readonly token?: string;
}

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
    // The owner's lists and rules are optional for a caller with none (restoring reads the vault alone).
    readonly policy: Pick<PrivacyShieldPolicy, "classes" | "allow" | "names"> & Partial<Pick<PrivacyShieldPolicy, "dictionary" | "rules">>;
    readonly memo: MaskMemo;
    readonly recognizer?: EntityRecognizer | undefined;
    // Where a rule that cannot run is said.
    readonly warn?: (message: string) => void;
}

// A value the vault holds, as the gate is asked about it where it was met: the spelling met, and the value as held.
const knownSpan = (text: string, start: number, end: number, hit: VaultHit): PolicySpan => ({
    start,
    end,
    class: hit.class,
    value: text.slice(start, end),
    by: hit.taught ? "taught" : "learned",
    known: hit.value,
});

// What the vault already knows in a stretch of text, as the gate takes it where it stands: a value is matched in its next
// shorter spelling where its longest is turned down. `noting` marks each as seen today, which is what the vault's
// retention ages by; a preview only reads.
const knownIn = (vault: PrivacyVault, gate: Gate, text: string, noting: boolean): Proposed[] =>
    vault
        .matcher()
        .find(text, (start, end, hit) => gate.admits(text, knownSpan(text, start, end, hit)))
        .map(({ start, end, payload }: { start: number; end: number; payload: VaultHit }) => {
            if (noting) {
                vault.saw(payload);
            }
            return { ...knownSpan(text, start, end, payload), token: payload.token };
        });

// Masker.known: the vault's values in a string around the tokens already in it, settled as the gate settles them.
const knownSpans = async (vault: PrivacyVault, gate: Gate, text: string): Promise<FoundSpan[]> => {
    await vault.load();
    const out: FoundSpan[] = [];
    let offset = 0;
    for (const part of segmentsAroundTokens(text)) {
        if (!part.token && HAS_WORD.test(part.text)) {
            for (const span of gate.settle(part.text, knownIn(vault, gate, part.text, false))) {
                if (span.token !== undefined) {
                    out.push({ start: offset + span.start, end: offset + span.end, class: span.class, token: span.token });
                }
            }
        }
        offset += part.text.length;
    }
    return out;
};

// One token back to its value: an escaped literal one prefix off, a token the scope did not give out as written.
const restoreToken = (vault: PrivacyVault, whole: string, label: string, index: string, scope: RestoreScope | undefined): string => {
    if (label.startsWith(LITERAL_PREFIX)) {
        return whole.replace(LITERAL_PREFIX, "");
    }
    if (scope !== undefined && RESTORABLE_LABELS.has(label) && !scope.given(tokenKey(label, index))) {
        scope.coined?.(whole);
        return whole;
    }
    return vault.resolve(label, index) ?? whole;
};

// Tokens back to the values they stand for, read from the vault alone; with a scope, only the tokens it gave out.
const restoreFrom = (vault: PrivacyVault, text: string, scope?: RestoreScope): string =>
    text.includes("⟦") || text.includes("[[")
        ? text.replace(tokenPattern(), (whole, label?: string, index?: string, looseLabel?: string, looseIndex?: string) =>
              restoreToken(vault, whole, label ?? looseLabel ?? "", index ?? looseIndex ?? "", scope),
          )
        : text;

const tally = (spans: readonly { readonly class: PersonalDataClass }[]) => {
    const counts: Partial<Record<PersonalDataClass, number>> = {};
    for (const span of spans) {
        counts[span.class] = (counts[span.class] ?? 0) + 1;
    }
    return counts;
};

// What a masker reads a stretch of text with.
interface Sources {
    readonly vault: PrivacyVault;
    readonly gate: Gate;
    readonly detector: PolicyDetector;
    readonly recognizer: EntityRecognizer | undefined;
}

const recognizedIn = async (recognizer: EntityRecognizer | undefined, text: string): Promise<Proposed[]> =>
    recognizer === undefined ? [] : (await recognizer.find(text)).map((span) => ({ ...span, by: "model" }));

// What every source proposes in a stretch of text holding no token, through the gate.
const proposedIn = async ({ vault, gate, detector, recognizer }: Sources, text: string, noting: boolean): Promise<Proposed[]> => {
    if (!HAS_WORD.test(text)) {
        return [];
    }
    return gate.settle(text, [...knownIn(vault, gate, text, noting), ...detector.candidates(text), ...(await recognizedIn(recognizer, text))]);
};

// What a stretch the provider wrote holds that the vault gave a token (Masker.own): its values found where they stand
// and in context, and a find that runs over one of them, which is given a token as `mask` would give it so the value
// inside does not go back beside the words the model put around its token. Any other find is the model's own word.
const ownProposedIn = async ({ vault, gate, detector, recognizer }: Sources, text: string): Promise<Proposed[]> => {
    if (!HAS_WORD.test(text)) {
        return [];
    }
    // Every value the vault holds where it stands, the gate not asked: a find that touches one is not the model's own.
    const held = vault.matcher().find(text);
    const found = [...detector.candidates(text), ...(await recognizedIn(recognizer, text))].flatMap((span): Proposed[] => {
        const token = vault.tokenOf(span.value, span.class);
        if (token !== undefined) {
            return [{ ...span, token }];
        }
        return held.some((hit) => hit.start < span.end && span.start < hit.end) ? [span] : [];
    });
    return gate.settle(text, [...knownIn(vault, gate, text, true), ...found]);
};

// Every find in a string around the tokens already in it, with where its stretch starts in the string.
const spansAround = async (sources: Sources, text: string, noting: boolean): Promise<{ readonly span: Proposed; readonly offset: number }[]> => {
    const out: { span: Proposed; offset: number }[] = [];
    let offset = 0;
    for (const part of segmentsAroundTokens(text)) {
        if (!part.token) {
            out.push(...(await proposedIn(sources, part.text, noting)).map((span) => ({ span, offset })));
        }
        offset += part.text.length;
    }
    return out;
};

export const createMasker = ({ vault, policy, memo, recognizer, warn }: MaskerDeps): Masker => {
    const detector = detectorFor(
        { classes: policy.classes, allow: policy.allow, dictionary: policy.dictionary ?? { off: [], lists: [] }, rules: policy.rules ?? [] },
        warn,
    );
    const { gate } = detector;
    const policyKey = JSON.stringify([detector.key, recognizer === undefined ? "dictionary" : policy.names]);
    // A rule's find is handed out as one, so the vault leaves it to the rule (privacy-vault.ts).
    const tokenOfSpan = (span: Proposed): string => span.token ?? vault.tokenFor(span.value, span.class, span.by === "rule" ? "rule" : undefined);

    // Replaces the chosen spans; tallies what it replaced, and where each token landed in the whole string (`base` is
    // where this stretch starts in it).
    const apply = (text: string, spans: readonly Proposed[], counts: Record<string, number>, placed: Placed[], base: number): string => {
        for (const span of spans) {
            counts[span.class] = (counts[span.class] ?? 0) + 1;
        }
        return placeTokens(text, spans.map((span) => ({ ...span, token: tokenOfSpan(span) })), placed, base);
    };

    const sources: Sources = { vault, gate, detector, recognizer };


    // Only the vault's values can have changed since a remembered masking; looking for those alone is a fraction of the
    // full pass.
    const remaskKnown = (text: string, counts: Record<string, number>, placed: Placed[]): string => {
        let out = "";
        for (const part of segmentsAroundTokens(text)) {
            out += part.token ? part.text : apply(part.text, gate.settle(part.text, knownIn(vault, gate, part.text, true)), counts, placed, out.length);
        }
        return out;
    };

    // A masking pass: `spansFor` proposes what a stretch with no token in it holds, `tag` keeps its memo apart.
    const masking = async (text: string, tag: string, spansFor: (text: string) => Promise<Proposed[]>): Promise<MaskResult> => {
        if (text.length < 2 || !HAS_WORD.test(text)) {
            return { text, counts: {}, found: [] };
        }
        await vault.load();
        const key = createHash("sha1").update(tag).update(policyKey).update("\0").update(text).digest("base64url");
        const remembered = memo.get(key);
        if (remembered !== undefined && remembered.generation === vault.generation()) {
            return { text: remembered.text, counts: {}, found: [] };
        }
        const counts: Record<string, number> = {};
        const placed: Placed[] = [];
        let masked = "";
        if (remembered === undefined) {
            for (const part of segmentsAroundTokens(text)) {
                masked += part.token ? escapedLiteral(part.text) : apply(part.text, await spansFor(part.text), counts, placed, masked.length);
            }
        } else {
            masked = remaskKnown(remembered.text, counts, placed);
        }
        // The generation after this masking's own additions: they are in `masked` already.
        memo.set(key, { text: masked, generation: vault.generation() });
        return { text: masked, counts, found: replacementsIn(masked, placed) };
    };

    return {
        mask: async (text) => masking(text, "", async (stretch) => proposedIn(sources, stretch, true)),
        own: async (text) => masking(text, "own\0", async (stretch) => ownProposedIn(sources, stretch)),
        find: async (text, keep = (spans) => spans) => {
            if (text.length < 2 || !HAS_WORD.test(text)) {
                return { spans: [], counts: {}, found: [] };
            }
            await vault.load();
            // Remembered as the masked strings are, under a key of its own: an image's words are re-sent with every
            // request of a conversation, and only the vault's values can change what they hold. Every find is kept, and
            // `keep` asked again on the way out.
            const key = createHash("sha1").update("find\0").update(policyKey).update("\0").update(text).digest("base64url");
            const remembered = memo.get(key);
            if (remembered !== undefined && remembered.generation === vault.generation()) {
                return { spans: keep(parseSpans(remembered.text)), counts: {}, found: [] };
            }
            const all: FoundSpan[] = (await spansAround(sources, text, true)).map(({ span, offset }) => ({
                start: offset + span.start,
                end: offset + span.end,
                class: span.class,
                token: tokenOfSpan(span),
            }));
            memo.set(key, { text: JSON.stringify(all), generation: vault.generation() });
            const spans = keep(all);
            // A string seen before counts nothing again, as with `mask`.
            if (remembered !== undefined) {
                return { spans, counts: {}, found: [] };
            }
            // The words as the picture reads once painted over: the same spans, each written as its token.
            const placed: Placed[] = [];
            const masked = placeTokens(text, spans, placed, 0);
            return { spans, counts: tally(spans), found: replacementsIn(masked, placed) };
        },
        restore: (text) => restoreFrom(vault, text),
        restoreGiven: (text, scope) => restoreFrom(vault, text, scope),
        inspect: async (text) => {
            await vault.load();
            return (await spansAround(sources, text, false)).map(({ span, offset }) => ({
                start: offset + span.start,
                end: offset + span.end,
                class: span.class,
                // The preview names a value the vault holds alike, taught or learned.
                by: span.by === "taught" ? "learned" : span.by,
                ...opt("rule", span.rule),
            }));
        },
        known: (text) => knownSpans(vault, gate, text),
    };
};
