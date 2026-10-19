import { REMEMBER_NOTHING, titleForOrigin, type CaptureCandidate } from "@intentic/sandbox-contract/policy/keyring-origins";
import type { KeyringOrigin } from "@intentic/sandbox-contract/schemas/keyring";
import type { EntryInfo, KeyringSettings } from "../protocol.js";
import type { StoredEntry, VaultDocument } from "../vault.js";

// AN ENTRY AS EACH READER SEES IT: the open part's line (names and rules, never a value), what origin matching compares
// (keyring-origins.ts), and the few changes every op makes the same way. Pure.

export const DEFAULT_SETTINGS: KeyringSettings = { remember: REMEMBER_NOTHING, neverSave: [], autoLockMinutes: 60, lockOnSleep: true };

export const settingsOf = (doc: VaultDocument): KeyringSettings => doc.settings ?? DEFAULT_SETTINGS;

export const liveEntries = (doc: VaultDocument): StoredEntry[] => Object.values(doc.entries).filter((entry) => entry.deleted !== true);

export const withEntry = (doc: VaultDocument, entry: StoredEntry): VaultDocument => ({ ...doc, entries: { ...doc.entries, [entry.name]: entry } });

export const entryInfoOf = (entry: StoredEntry): EntryInfo => {
    const info: EntryInfo = { name: entry.name, ...entry.rules, source: entry.source, shares: entry.shares, createdAt: entry.createdAt, updatedAt: entry.updatedAt };
    if (entry.backend !== undefined) {
        info.backend = entry.backend;
    }
    if (entry.captured !== undefined) {
        info.captured = entry.captured;
    }
    if (entry.fresh === true) {
        info.fresh = true;
    }
    if (entry.unverified === true) {
        info.unverified = true;
    }
    if (entry.lastUsedAt !== undefined) {
        info.lastUsedAt = entry.lastUsedAt;
    }
    if ((entry.history?.length ?? 0) > 0) {
        info.versions = entry.history?.length;
    }
    return info;
};

// What a capture, a need or a fill compares an entry by.
export const candidateOf = (entry: EntryInfo): CaptureCandidate & { readonly name: string } => ({
    name: entry.name,
    rules: { programs: entry.programs, packages: entry.packages, hosts: entry.hosts, askpass: entry.askpass },
    username: entry.username,
    title: entry.title,
});

export const titleOf = (entry: EntryInfo): string => entry.title ?? entry.name;

// A place in a prompt's words: "github.com", "ssh radar@build-01".
export const placeWords = (origin: KeyringOrigin): string => titleForOrigin(origin);

// An entry seen to work: used just now, no longer waiting to be proved, nor marked failed.
export const usedEntry = (entry: StoredEntry, now: number): StoredEntry => {
    const { unverified: _unverified, failed: _failed, ...rest } = entry;
    return { ...rest, lastUsedAt: now };
};

// Weak: shorter than 12 characters, or drawn from one kind of character; reused: the same value in another entry.
const CHARSETS = [/[a-z]/u, /[A-Z]/u, /[0-9]/u, /[^A-Za-z0-9]/u];
const isWeak = (value: string): boolean => value.length < 12 || CHARSETS.filter((set) => set.test(value)).length < 2;

export const healthOf = (entries: readonly StoredEntry[]): Map<string, { weak: boolean; reused: boolean }> => {
    const counts = new Map<string, number>();
    for (const entry of entries) {
        if (entry.value !== undefined) {
            counts.set(entry.value, (counts.get(entry.value) ?? 0) + 1);
        }
    }
    const health = new Map<string, { weak: boolean; reused: boolean }>();
    for (const entry of entries) {
        if (entry.value !== undefined && entry.rules.kind === "password") {
            health.set(entry.name, { weak: isWeak(entry.value), reused: (counts.get(entry.value) ?? 0) > 1 });
        }
    }
    return health;
};
