import { type PersonalDataClass, PersonalDataClassSchema, type PrivacyKnownSource, type PrivacyKnownValue } from "@intentic/sandbox-contract";
import { z } from "zod";
import { defineDocument } from "../store/evolution/documents.js";
import type { JsonFile } from "../store/json-file.js";
import { openDocument } from "../store/open-document.js";
import { personalAlone } from "./detect/standalone.js";
import { createKnownMatcher, type KnownMatcher, type Spelling, spellingKey } from "./known-matcher.js";
import { TOKEN_LABEL, tokenKey, tokenOf } from "./tokens.js";

// Which value each token stands for. One vault per workspace, so a value is the same token in every conversation,
// subagent and provider switch, and a transcript re-sent on resume masks to exactly the bytes it masked to before. It
// holds the real values, so it lives with the credentials (mode 0600, off the workspace). Every value in it is matched
// from then on, wherever it appears and in every spelling its kind allows (spellingOf): a name the detector found once
// in context is caught again where the context is missing, and a dataset the owner taught is caught whether or not any
// detector would have found it. A found value that is personal only in context (an ordinary word that is also a name,
// a value an older detector misread) is not matched alone, though its token still resolves.

const VaultEntrySchema = z.object({
    value: z.string(),
    class: PersonalDataClassSchema,
    index: z.number().int().positive(),
    // The dataset it was taught from; absent for a value the detectors found.
    source: z.string().optional(),
    at: z.string().optional(),
    // Forgotten: its token still resolves (an earlier conversation still holds it), but it is no longer matched.
    retired: z.boolean().optional(),
});
type VaultEntry = z.infer<typeof VaultEntrySchema>;

export const privacyVaultDocument = defineDocument({
    root: "auth",
    path: "privacy-vault.json",
    schema: z.object({
        // Each label's next index. Kept rather than derived, so a forgotten value's index is never handed to another:
        // a provider may still hold the old token, and resolving it to somebody else would be worse than not at all.
        next: z.record(z.string(), z.number().int()).default({}),
        entries: z.array(VaultEntrySchema).default([]),
    }),
});

// The vault's matcher keys each value to its token.
export interface VaultHit {
    readonly class: PersonalDataClass;
    readonly token: string;
}

export interface PrivacyVault {
    // Reads the file once; later calls return at once. Throws on a file that exists but cannot be read, since a fresh
    // vault would hand out indexes the provider already knows as somebody else.
    readonly load: () => Promise<void>;
    // The token for a value, given a new one when it has none. Synchronous, so concurrent requests never race for an
    // index; held in memory until `commit`.
    readonly tokenFor: (value: string, kind: PersonalDataClass) => string;
    // Writes what `tokenFor` added since the last commit. Called before a masked request leaves: a token the provider
    // reads must already be on disk, or a restart would give its index to another value.
    readonly commit: () => Promise<void>;
    // The value behind a token, by its label and index; undefined for a token this vault never gave out.
    readonly resolve: (label: string, index: string) => string | undefined;
    // Every value matched in each spelling it allows, keyed to its token; rebuilt only when the vault changed.
    readonly matcher: () => KnownMatcher<VaultHit>;
    // Bumps whenever a matched value is added or retired, so a cached masking knows to look again.
    readonly generation: () => number;
    readonly learn: (source: string, values: readonly PrivacyKnownValue[]) => Promise<{ added: number; known: number }>;
    readonly forget: (source: string) => Promise<number>;
    readonly sources: () => Promise<PrivacyKnownSource[]>;
    readonly counts: () => Promise<{ readonly tokens: number; readonly known: number }>;
}

// A value with characters outside ASCII is also matched as Python's `json.dumps` writes it by default (`Łukasz`),
// which is how a script's output most often carries a Polish name past a detector reading for letters.
// Per UTF-16 unit, not per code point, since that is how the escape spells a character outside the basic plane.
const NON_ASCII = /[^\x00-\x7f]/g;
const escapedForm = (value: string): string | undefined =>
    value.search(NON_ASCII) === -1 ? undefined : value.replace(NON_ASCII, (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`);

// A token's number as the vault writes it: no sign, no leading zero, never 0.
const CANONICAL_INDEX = /^[1-9]\d*$/u;

// How a value of a kind may be re-spelled and still be that value (known-matcher.ts): an e-mail address in any case; a
// value of several words or with a digit in it (a full name, a document or account number) in any case and with its
// separators anywhere or nowhere; one plain word only as written, since case is all that tells a name from a word.
const spellingOf = (value: string, kind: PersonalDataClass): Spelling => {
    if (kind === "email") {
        return "case";
    }
    return /\p{N}/u.test(value) || (value.match(/[\p{L}\p{N}]+/gu) ?? []).length > 1 ? "folded" : "exact";
};

// The key a value is known by: the same for every spelling of it, so a re-spelled value keeps the token it has.
const valueKey = (value: string, kind: PersonalDataClass): string => spellingKey(value, spellingOf(value, kind));

// Below this, an exact match is more likely an ordinary word than the value it came from.
const MIN_MATCHED = 3;

export class PrivacyVaultUnreadableError extends Error {
    constructor(path: string, detail: string) {
        super(`the privacy shield's vault at ${path} could not be read (${detail}); no masked request can leave until it can`);
        this.name = "PrivacyVaultUnreadableError";
    }
}

// The vault's whole value, as its document stores it.
export type VaultValue = z.output<typeof privacyVaultDocument.schema>;

export const filePrivacyVault = (path: string, now: () => Date = () => new Date()): PrivacyVault =>
    createPrivacyVault(
        openDocument(privacyVaultDocument, path, {
            fallback: (): VaultValue => ({ next: {}, entries: [] }),
            mode: 0o600,
            onUnreadable: "refuse",
        }),
        path,
        now,
    );

// The vault over any store of its value; `where` names that store in an error.
export const createPrivacyVault = (file: JsonFile<VaultValue>, where: string, now: () => Date = () => new Date()): PrivacyVault => {
    const path = where;
    let loading: Promise<void> | undefined;
    const next = new Map<string, number>();
    const byValue = new Map<string, VaultEntry>();
    // The folded values again, by their folded key alone: `JanKowalski` is one plain word by its own spelling, and still
    // the full name the vault knows.
    const byFolded = new Map<string, VaultEntry>();
    const byToken = new Map<string, VaultEntry>();
    let dirty = false;
    let generation = 0;
    let built: { readonly generation: number; readonly matcher: KnownMatcher<VaultHit> } | undefined;

    const keyOfEntry = (entry: VaultEntry): string => tokenKey(TOKEN_LABEL[entry.class], entry.index);
    // Every entry stays by its token, so every token ever given out resolves; by value, one entry stands for every
    // spelling of it. Two that a vault written before spellings counted holds apart keep the first, unless it was
    // forgotten and the other was not.
    const index = (entry: VaultEntry): void => {
        byToken.set(keyOfEntry(entry), entry);
        const stands = (standing: VaultEntry | undefined): boolean =>
            standing === undefined || keyOfEntry(standing) === keyOfEntry(entry) || (standing.retired === true && entry.retired !== true);
        const key = valueKey(entry.value, entry.class);
        if (stands(byValue.get(key))) {
            byValue.set(key, entry);
        }
        const folded = spellingKey(entry.value, "folded");
        if (spellingOf(entry.value, entry.class) === "folded" && stands(byFolded.get(folded))) {
            byFolded.set(folded, entry);
        }
    };
    // The entry a value is a spelling of: by its own key, else as a folded spelling of a value the vault knows folded.
    const knownAs = (value: string, kind: PersonalDataClass): VaultEntry | undefined =>
        byValue.get(valueKey(value, kind)) ?? (kind === "email" ? undefined : byFolded.get(spellingKey(value, "folded")));
    const snapshot = () => ({ next: Object.fromEntries(next), entries: [...byToken.values()] });
    const allocate = (value: string, kind: PersonalDataClass, extra: Partial<VaultEntry> = {}): VaultEntry => {
        const label = TOKEN_LABEL[kind];
        const nextIndex = next.get(label) ?? 1;
        next.set(label, nextIndex + 1);
        const entry: VaultEntry = { value, class: kind, index: nextIndex, ...extra };
        index(entry);
        dirty = true;
        generation += 1;
        return entry;
    };
    const loaded = (): void => {
        if (loading === undefined) {
            throw new Error("the privacy vault was used before it was loaded");
        }
    };
    const load = (): Promise<void> => {
        loading ??= (async () => {
            const state = await file.state();
            if (state.unreadable) {
                throw new PrivacyVaultUnreadableError(path, state.detail);
            }
            for (const [label, value] of Object.entries(state.value.next)) {
                next.set(label, value);
            }
            for (const entry of state.value.entries) {
                index(entry);
                // A file whose counters lag its entries (hand-edited, or older) must still never repeat an index.
                const label = TOKEN_LABEL[entry.class];
                next.set(label, Math.max(next.get(label) ?? 1, entry.index + 1));
            }
        })().catch((error: unknown) => {
            // A failed read is tried again next time rather than remembered as loaded.
            loading = undefined;
            throw error;
        });
        return loading;
    };
    const commit = async (): Promise<void> => {
        if (!dirty) {
            return;
        }
        dirty = false;
        try {
            await file.update(() => snapshot());
        } catch (error) {
            dirty = true;
            throw error;
        }
    };
    return {
        load,
        tokenFor: (value, kind) => {
            loaded();
            const existing = knownAs(value, kind);
            if (existing !== undefined) {
                if (existing.retired === true) {
                    // Found again by a detector after being forgotten: matched again, under the token it already had.
                    const revived: VaultEntry = { ...existing, retired: false };
                    index(revived);
                    dirty = true;
                    generation += 1;
                    return tokenOf(TOKEN_LABEL[revived.class], revived.index);
                }
                return tokenOf(TOKEN_LABEL[existing.class], existing.index);
            }
            const entry = allocate(value, kind);
            return tokenOf(TOKEN_LABEL[entry.class], entry.index);
        },
        commit,
        // Only as the vault writes a number: `PERSON_01` is a token nobody gave out, not another spelling of `PERSON_1`.
        resolve: (label, tokenIndex) => (CANONICAL_INDEX.test(tokenIndex) ? byToken.get(tokenKey(label, Number(tokenIndex)))?.value : undefined),
        generation: () => generation,
        matcher: () => {
            loaded();
            if (built !== undefined && built.generation === generation) {
                return built.matcher;
            }
            // A value the owner taught is matched whatever it is; one the detectors found, only while it would still be
            // personal data standing alone (detect/standalone.ts).
            const values = [...byValue.values()]
                .filter((entry) => entry.retired !== true && entry.value.length >= MIN_MATCHED)
                .filter((entry) => entry.source !== undefined || personalAlone(entry.value, entry.class))
                .flatMap((entry) => {
                    const hit: VaultHit = { class: entry.class, token: tokenOf(TOKEN_LABEL[entry.class], entry.index) };
                    const spelling = spellingOf(entry.value, entry.class);
                    const escaped = escapedForm(entry.value);
                    return escaped === undefined
                        ? [{ value: entry.value, payload: hit, spelling }]
                        : [
                              { value: entry.value, payload: hit, spelling },
                              { value: escaped, payload: hit, spelling },
                          ];
                });
            built = { generation, matcher: createKnownMatcher(values) };
            return built.matcher;
        },
        learn: async (source, values) => {
            await load();
            const at = now().toISOString();
            let added = 0;
            for (const { value, class: kind } of values) {
                const trimmed = value.trim();
                if (trimmed.length < MIN_MATCHED) {
                    continue;
                }
                const existing = knownAs(trimmed, kind);
                if (existing === undefined) {
                    allocate(trimmed, kind, { source, at });
                    added += 1;
                } else if (existing.source === undefined || existing.retired === true) {
                    index({ ...existing, source, at, retired: false });
                    dirty = true;
                    generation += 1;
                    added += 1;
                }
            }
            await commit();
            return { added, known: [...byToken.values()].filter((entry) => entry.source !== undefined && entry.retired !== true).length };
        },
        forget: async (source) => {
            await load();
            let forgotten = 0;
            for (const entry of byToken.values()) {
                if (entry.source === source && entry.retired !== true) {
                    index({ ...entry, retired: true });
                    forgotten += 1;
                }
            }
            if (forgotten > 0) {
                dirty = true;
                generation += 1;
                await commit();
            }
            return forgotten;
        },
        sources: async () => {
            await load();
            const bySource = new Map<string, { count: number; at: string }>();
            for (const entry of byToken.values()) {
                if (entry.source === undefined || entry.retired === true) {
                    continue;
                }
                const current = bySource.get(entry.source) ?? { count: 0, at: entry.at ?? "" };
                bySource.set(entry.source, { count: current.count + 1, at: (entry.at ?? "") > current.at ? (entry.at ?? "") : current.at });
            }
            return [...bySource].map(([source, { count, at }]) => ({ source, count, at })).toSorted((left, right) => right.at.localeCompare(left.at));
        },
        counts: async () => {
            await load();
            const entries = [...byToken.values()];
            return { tokens: entries.length, known: entries.filter((entry) => entry.source !== undefined && entry.retired !== true).length };
        },
    };
};
