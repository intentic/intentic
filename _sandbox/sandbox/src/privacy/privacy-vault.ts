import {
    type PersonalDataClass,
    PersonalDataClassSchema,
    type PrivacyKnownSource,
    type PrivacyKnownValue,
} from "@intentic/sandbox-contract/schemas/privacy";
import { z } from "zod";
import { defineDocument } from "../store/evolution/documents.js";
import type { JsonFile } from "../store/json-file.js";
import { openDocument } from "../store/open-document.js";
import { personalAlone } from "@intentic/privacy-detect/standalone";
import { createKnownMatcher, type KnownMatcher, type KnownValue, type Spelling, spellingKey } from "./known-matcher.js";
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
    // The day (YYYY-MM-DD) it was last handed out or matched, what settings.retention.privacyVaultDays ages it by. Kept
    // to the day, so a busy vault is written at most once a day per value for it. Absent in a vault written before it.
    seen: z.string().optional(),
    // Written by releases before 2026-10-13, whose forget kept the value and only stopped matching it. Such an entry is
    // dropped as the vault loads, and never written again.
    retired: z.boolean().optional(),
    // Found only by one of the owner's own rules (privacy policy `rules`), which matches it itself while it is on: the
    // vault resolves its token but does not match it alone, so switching the rule off stops masking it. Found by a
    // detector too, it loses the mark and is matched as their finds are.
    rule: z.boolean().optional(),
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
    // The entry's key (tokenKey), for `saw`.
    readonly key: string;
}

export interface PrivacyVault {
    // Reads the file once; later calls return at once. Throws on a file that exists but cannot be read, since a fresh
    // vault would hand out indexes the provider already knows as somebody else.
    readonly load: () => Promise<void>;
    // The token for a value, given a new one when it has none. Synchronous, so concurrent requests never race for an
    // index; held in memory until `commit`. `rule` when one of the owner's rules found it (VaultEntrySchema `rule`).
    readonly tokenFor: (value: string, kind: PersonalDataClass, found?: "rule") => string;
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
    // Deletes every value taught from a source, raw value and all: its token resolves to nothing from then on, and the
    // value is new if it comes back. Answers how many it deleted.
    readonly forget: (source: string) => Promise<number>;
    // Notes that a matched value was seen today; written with the next commit.
    readonly saw: (hit: VaultHit) => void;
    // Deletes every value the detectors found that was last seen before `before` (settings.retention.privacyVaultDays),
    // and answers how many. A value taught from a list stays until its list is forgotten: it is the owner's own
    // instruction of what to protect, and dropping it would let the value through unmasked.
    readonly expire: (before: Date) => Promise<number>;
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

// The key an entry is held by: its token's label and number.
const keyOfEntry = (entry: VaultEntry): string => tokenKey(TOKEN_LABEL[entry.class], entry.index);

// The UTC day a moment falls on, as an entry's `seen` writes it.
const utcDayOf = (date: Date): string => date.toISOString().slice(0, 10);

// The values taught from one source.
const taughtFrom = (entries: Iterable<VaultEntry>, source: string): VaultEntry[] => {
    const taught: VaultEntry[] = [];
    for (const entry of entries) {
        if (entry.source === source) {
            taught.push(entry);
        }
    }
    return taught;
};

// What an expiry at `cutoff` (a day) deletes, and what it finds never stamped and stamps instead: only values the
// detectors found, never one taught from a list.
interface AgedEntries {
    readonly gone: VaultEntry[];
    readonly unstamped: VaultEntry[];
}

const agedEntries = (entries: Iterable<VaultEntry>, cutoff: string): AgedEntries => {
    const gone: VaultEntry[] = [];
    const unstamped: VaultEntry[] = [];
    for (const entry of entries) {
        if (entry.source !== undefined) {
            continue;
        }
        if (entry.seen === undefined) {
            unstamped.push(entry);
        } else if (entry.seen < cutoff) {
            gone.push(entry);
        }
    }
    return { gone, unstamped };
};

// Whether `entry` may stand for a key `standing` holds: nobody holds it yet, or it is the same entry.
const mayStand = (standing: VaultEntry | undefined, entry: VaultEntry): boolean =>
    standing === undefined || keyOfEntry(standing) === keyOfEntry(entry);

// Whether a find loses an entry its rule mark: it is marked, and something other than a rule found it.
const unmarkedBy = (entry: VaultEntry, found: "rule" | undefined): boolean => entry.rule === true && found !== "rule";

// The mark a new entry carries for what found it.
const markOf = (found: "rule" | undefined): Partial<VaultEntry> => (found === "rule" ? { rule: true } : {});

// What the matcher matches, each value in each spelling it is written in. A value the owner taught is matched whatever it
// is; one the detectors found, only while it would still be personal data standing alone (@intentic/privacy-detect
// standalone.ts); one only an owner's rule found, never, since the rule matches it itself while it is on.
const matchedValues = (entries: Iterable<VaultEntry>): KnownValue<VaultHit>[] =>
    [...entries]
        .filter((entry) => entry.value.length >= MIN_MATCHED)
        .filter((entry) => entry.source !== undefined || (entry.rule !== true && personalAlone(entry.value, entry.class)))
        .flatMap((entry) => {
            const hit: VaultHit = { class: entry.class, token: tokenOf(TOKEN_LABEL[entry.class], entry.index), key: keyOfEntry(entry) };
            const spelling = spellingOf(entry.value, entry.class);
            const escaped = escapedForm(entry.value);
            return escaped === undefined
                ? [{ value: entry.value, payload: hit, spelling }]
                : [
                      { value: entry.value, payload: hit, spelling },
                      { value: escaped, payload: hit, spelling },
                  ];
        });

// Each source values were taught from, how many, and when last; the newest first.
const sourcesOf = (entries: Iterable<VaultEntry>): PrivacyKnownSource[] => {
    const bySource = new Map<string, { count: number; at: string }>();
    for (const entry of entries) {
        if (entry.source === undefined) {
            continue;
        }
        const current = bySource.get(entry.source) ?? { count: 0, at: entry.at ?? "" };
        bySource.set(entry.source, { count: current.count + 1, at: (entry.at ?? "") > current.at ? (entry.at ?? "") : current.at });
    }
    return [...bySource].map(([source, { count, at }]) => ({ source, count, at })).toSorted((left, right) => right.at.localeCompare(left.at));
};

// The vault's whole value, as its document stores it.
export type VaultValue = z.output<typeof privacyVaultDocument.schema>;

// Each label's next index as a file holds it, raised past every entry's own: a file whose counters lag its entries
// (hand-edited, or older) must still never repeat an index.
const nextIndexes = (value: VaultValue): Map<string, number> => {
    const next = new Map(Object.entries(value.next));
    for (const entry of value.entries) {
        const label = TOKEN_LABEL[entry.class];
        next.set(label, Math.max(next.get(label) ?? 1, entry.index + 1));
    }
    return next;
};

export const filePrivacyVault = (path: string, now: () => Date = () => new Date()): PrivacyVault =>
    createPrivacyVault(
        openDocument(privacyVaultDocument, path, {
            fallback: (): VaultValue => ({ next: {}, entries: [] }),
            mode: 0o600,
            onUnreadable: "refuse",
            atRestPurpose: privacyVaultDocument.path,
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

    // Every entry stays by its token until it is deleted, so every token it gave out resolves; by value, one entry stands
    // for every spelling of it. Two that a vault written before spellings counted holds apart keep the first.
    const index = (entry: VaultEntry): void => {
        byToken.set(keyOfEntry(entry), entry);
        const key = valueKey(entry.value, entry.class);
        if (mayStand(byValue.get(key), entry)) {
            byValue.set(key, entry);
        }
        const folded = spellingKey(entry.value, "folded");
        if (spellingOf(entry.value, entry.class) === "folded" && mayStand(byFolded.get(folded), entry)) {
            byFolded.set(folded, entry);
        }
    };
    // The entry a value is a spelling of: by its own key, else as a folded spelling of a value the vault knows folded.
    const knownAs = (value: string, kind: PersonalDataClass): VaultEntry | undefined =>
        byValue.get(valueKey(value, kind)) ?? (kind === "email" ? undefined : byFolded.get(spellingKey(value, "folded")));
    const snapshot = () => ({ next: Object.fromEntries(next), entries: [...byToken.values()] });
    // Deletes entries for good: the by-value maps are rebuilt from what remains, so another spelling an older vault held
    // apart takes the place again. `next` is untouched, so a deleted index is never handed to another value.
    const drop = (gone: readonly VaultEntry[]): void => {
        for (const entry of gone) {
            byToken.delete(keyOfEntry(entry));
        }
        byValue.clear();
        byFolded.clear();
        for (const entry of byToken.values()) {
            index(entry);
        }
        dirty = true;
        generation += 1;
    };
    const touch = (entry: VaultEntry): void => {
        const day = utcDayOf(now());
        if (entry.seen !== day) {
            index({ ...entry, seen: day });
            dirty = true;
        }
    };
    const allocate = (value: string, kind: PersonalDataClass, extra: Partial<VaultEntry> = {}): VaultEntry => {
        const label = TOKEN_LABEL[kind];
        const nextIndex = next.get(label) ?? 1;
        next.set(label, nextIndex + 1);
        const entry: VaultEntry = { value, class: kind, index: nextIndex, seen: utcDayOf(now()), ...extra };
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
            for (const [label, value] of nextIndexes(state.value)) {
                next.set(label, value);
            }
            for (const entry of state.value.entries) {
                if (entry.retired === true) {
                    // Forgotten by an older release that kept the value: it leaves the file with the next commit.
                    dirty = true;
                    continue;
                }
                index(entry);
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
        tokenFor: (value, kind, found) => {
            loaded();
            const existing = knownAs(value, kind);
            if (existing === undefined) {
                const entry = allocate(value, kind, markOf(found));
                return tokenOf(TOKEN_LABEL[entry.class], entry.index);
            }
            touch(existing);
            // Found by something other than a rule, it is matched alone as the detectors' finds are from then on.
            if (unmarkedBy(existing, found)) {
                const { rule: _, ...rest } = byToken.get(keyOfEntry(existing)) ?? existing;
                index(rest);
                dirty = true;
                generation += 1;
            }
            return tokenOf(TOKEN_LABEL[existing.class], existing.index);
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
            built = { generation, matcher: createKnownMatcher(matchedValues(byValue.values())) };
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
                } else if (existing.source === undefined) {
                    index({ ...existing, source, at, seen: utcDayOf(now()) });
                    dirty = true;
                    generation += 1;
                    added += 1;
                }
            }
            await commit();
            return { added, known: [...byToken.values()].filter((entry) => entry.source !== undefined).length };
        },
        // Before 2026-10-13 forgetting only stopped the matching and kept the raw value in the file, which no erasure
        // request is satisfied by. Nothing of the value is kept, not even a hash: a hash of a PESEL or a phone number
        // beside nothing secret is the number again to anyone who tries them all. The cost is that its old token stops
        // resolving, so a transcript that holds it shows the token.
        forget: async (source) => {
            await load();
            const gone = taughtFrom(byToken.values(), source);
            if (gone.length > 0) {
                drop(gone);
            }
            await commit();
            return gone.length;
        },
        saw: (hit) => {
            const entry = byToken.get(hit.key);
            if (entry !== undefined) {
                touch(entry);
            }
        },
        expire: async (before) => {
            await load();
            const { gone, unstamped } = agedEntries(byToken.values(), utcDayOf(before));
            // Written before it was tracked: its age counts from the first sweep that finds it.
            for (const entry of unstamped) {
                touch(entry);
            }
            if (gone.length > 0) {
                drop(gone);
            }
            await commit();
            return gone.length;
        },
        sources: async () => {
            await load();
            return sourcesOf(byToken.values());
        },
        counts: async () => {
            await load();
            const entries = [...byToken.values()];
            return { tokens: entries.length, known: entries.filter((entry) => entry.source !== undefined).length };
        },
    };
};
