import { entriesFor, originKey, rulesServe } from "@intentic/sandbox-contract/policy/keyring-origins";
import type { KeyringOrigin } from "@intentic/sandbox-contract/schemas/keyring";
import { z } from "zod";
import { type Answer, NOT_SET_UP, refuse, type VaultAccess } from "./access.js";
import { candidateOf, DEFAULT_SETTINGS, entryInfoOf, liveEntries, placeWords, settingsOf, titleOf, usedEntry, withEntry } from "./entries.js";
import { type ActivityItem, type EntryInfo, type KeyringResponse, type KeyringSettings, type KeyringSettingsPatch, KeyringSettingsSchema } from "../protocol.js";
import { HISTORY_MAX, type StoredEntry } from "../vault.js";

// THE PASSWORDS APP'S OWN OPS on this computer: showing or copying a value for the person in front of it, an entry's
// earlier values, the app's settings, its Activity, and a browser's fill (through the native host). A value leaves only
// at a verified yes (Windows Hello, polkit, the recovery key); a user name, a title or a list of names does not need one.

// ---- settings ----

const REMEMBER_SOURCES = ["browser", "terminal", "apps", "phone", "sandbox"] as const satisfies readonly (keyof KeyringSettings["remember"])[];
type HistoryRow = Extract<KeyringResponse<"history">, { ok: true }>["versions"][number];
type CandidateRow = Extract<KeyringResponse<"candidates">, { ok: true }>["matches"][number];

/** The settings a patch makes of `current`, each list without repeats. Pure. */
const patchedSettings = (current: KeyringSettings, patch: KeyringSettingsPatch): KeyringSettings => {
    const next: KeyringSettings = {
        remember: {
            browser: patch.remember?.browser ?? current.remember.browser,
            terminal: patch.remember?.terminal ?? current.remember.terminal,
            apps: patch.remember?.apps ?? current.remember.apps,
            phone: patch.remember?.phone ?? current.remember.phone,
            sandbox: patch.remember?.sandbox ?? current.remember.sandbox,
        },
        neverSave: [...new Map((patch.neverSave ?? current.neverSave).map((origin) => [originKey(origin), origin])).values()],
        autoLockMinutes: patch.autoLockMinutes ?? current.autoLockMinutes,
        lockOnSleep: patch.lockOnSleep ?? current.lockOnSleep,
    };
    if (current.rememberAskedAt !== undefined) {
        next.rememberAskedAt = current.rememberAskedAt;
    }
    return next;
};

/**
 * What a change of settings lets in that it did not before, in words for the prompt: a remember switch turned on, or a
 * place taken off the never-save list. Turning a switch off or adding a place lets nothing in, so it asks nobody. Pure.
 */
const settingsWidening = (current: KeyringSettings, next: KeyringSettings): string[] => {
    const switched = REMEMBER_SOURCES.filter((source) => next.remember[source] && !current.remember[source]);
    const kept = new Set(next.neverSave.map(originKey));
    const freed = current.neverSave.filter((origin) => !kept.has(originKey(origin)));
    return [
        ...(switched.length === 0 ? [] : [`remembers the passwords you type in: ${switched.join(", ")}`]),
        ...(freed.length === 0 ? [] : [`saves again for ${freed.map(placeWords).join(", ")}`]),
    ];
};

// ---- activity ----

const AuditLineSchema = z.object({
    at: z.string(),
    op: z.string(),
    outcome: z.string(),
    secret: z.string().optional(),
    sandbox: z.string().optional(),
    program: z.string().optional(),
    target: z.string().optional(),
    asked: z.boolean().optional(),
    code: z.string().optional(),
});

/** The record's lines as the app's Activity, newest first, for one entry or all. Pure. */
const activityOf = (lines: readonly string[], name: string | undefined, limit: number): ActivityItem[] => {
    const items: ActivityItem[] = [];
    for (let index = lines.length - 1; index >= 0 && items.length < limit; index--) {
        let json: unknown;
        try {
            json = JSON.parse(lines[index] ?? "");
        } catch {
            // allow(silent-catch): a line cut short by a full disk is not an event, and the rest still are
            continue;
        }
        const parsed = AuditLineSchema.safeParse(json);
        if (parsed.success && (name === undefined || parsed.data.secret === name)) {
            const { at, ...rest } = parsed.data;
            const item: ActivityItem = { ...rest, at: Date.parse(at) };
            items.push(item);
        }
    }
    return items;
};

// ---- the ops ----

export class AppOps {
    constructor(private readonly vault: VaultAccess) {}

    // The entries as the person sees them: the inner document's while unlocked, the open part's while locked.
    #shown(): EntryInfo[] {
        const held = this.vault.held();
        return held === undefined ? (this.vault.file()?.open.entries ?? []) : liveEntries(held.doc).map(entryInfoOf);
    }

    #entry(name: string): EntryInfo | undefined {
        return this.#shown().find((entry) => entry.name === name);
    }

    async reveal(name: string, version: number | undefined): Answer<"reveal"> {
        const file = this.vault.file();
        const shown = this.#entry(name);
        if (file === undefined || shown === undefined) {
            return refuse("unknown", `There is no password named ${name}.`);
        }
        const earlier = version === undefined ? "" : " (an earlier one)";
        const opened = await this.vault.open(file, { title: `Show ${titleOf(shown)}'s password?`, message: `The Passwords app on this computer asks to show ${titleOf(shown)}'s password${earlier}.`, person: true });
        if ("ok" in opened) {
            return opened;
        }
        const entry = opened.doc.entries[name];
        if (entry === undefined || entry.deleted === true) {
            return refuse("unknown", `There is no password named ${name}.`);
        }
        const value = version === undefined ? await this.vault.valueOf(opened.doc, entry) : historyValue(entry, version);
        if (!value.ok) {
            return value;
        }
        await this.vault.record({ op: "reveal", outcome: "granted", secret: name, asked: true, how: opened.how });
        return withUsername({ ok: true, value: value.value }, entry.rules.username);
    }

    async copy(name: string, field: "password" | "username", clearAfterSeconds: number): Answer<"copy"> {
        const file = this.vault.file();
        const shown = this.#entry(name);
        if (file === undefined || shown === undefined) {
            return refuse("unknown", `There is no password named ${name}.`);
        }
        const clipboard = this.vault.deps.typist.clipboard;
        if (clipboard === undefined) {
            return refuse("unavailable", "Passwords cannot reach this computer's clipboard.");
        }
        let value: string;
        if (field === "username") {
            if (shown.username === undefined) {
                return refuse("unknown", `${titleOf(shown)} has no user name.`);
            }
            value = shown.username;
        } else {
            const opened = await this.vault.open(file, { title: `Copy ${titleOf(shown)}'s password?`, message: `It goes on the clipboard for ${String(clearAfterSeconds)} seconds.`, person: true });
            if ("ok" in opened) {
                return opened;
            }
            const entry = opened.doc.entries[name];
            const read = entry === undefined || entry.deleted === true ? refuse("unknown", `There is no password named ${name}.`) : await this.vault.valueOf(opened.doc, entry);
            if (!read.ok) {
                return read;
            }
            value = read.value;
        }
        const written = await clipboard.write(value);
        if (!written.ok) {
            return refuse("unavailable", written.reason);
        }
        const clearsAt = this.vault.deps.now() + clearAfterSeconds * 1000;
        // Taken off again only if it is still what was put there: something the person copied since stays.
        void this.vault.deps.sleep(clearAfterSeconds * 1000).then(async () => await clipboard.clearIf(value));
        await this.vault.record({ op: "copy", outcome: "granted", secret: name, target: field, asked: field === "password" });
        return { ok: true, clearsAt };
    }

    // Times and sources only: the values stay in the vault until `reveal` asks for one.
    async history(name: string): Answer<"history"> {
        const file = this.vault.file();
        if (file === undefined || this.#entry(name) === undefined) {
            return refuse("unknown", `There is no password named ${name}.`);
        }
        const opened = await this.vault.open(file, { title: "Unlock Passwords?", message: `Passwords is locked: unlock it to see ${name}'s earlier passwords.`, person: false });
        if ("ok" in opened) {
            return opened;
        }
        const versions = (opened.doc.entries[name]?.history ?? []).map((item, version) => {
            const row: HistoryRow = { version, at: item.at };
            if (item.captured !== undefined) {
                row.captured = item.captured;
            }
            return row;
        });
        return { ok: true, versions };
    }

    async restore(name: string, version: number): Answer<"restore"> {
        const file = this.vault.file();
        const shown = this.#entry(name);
        if (file === undefined || shown === undefined) {
            return refuse("unknown", `There is no password named ${name}.`);
        }
        const opened = await this.vault.open(file, { title: `Put back an earlier password for ${titleOf(shown)}?`, message: "The one it has now is kept in its history.", person: true });
        if ("ok" in opened) {
            return opened;
        }
        const entry = opened.doc.entries[name];
        const restored = entry === undefined ? undefined : restoredEntry(entry, version, this.vault.deps.now(), opened.doc.revision + 1);
        if (restored === undefined) {
            return refuse("unknown", `${name} has no earlier password ${String(version)}.`);
        }
        await this.vault.commit({ doc: withEntry(opened.doc, restored), key: opened.key });
        await this.vault.record({ op: "restore", outcome: "done", secret: name, asked: true });
        return { ok: true };
    }

    settings(): KeyringSettings {
        const held = this.vault.held();
        return held === undefined ? (this.vault.file()?.open.settings ?? DEFAULT_SETTINGS) : settingsOf(held.doc);
    }

    async setSettings(patch: KeyringSettingsPatch): Answer<"set-settings"> {
        const file = this.vault.file();
        if (file === undefined) {
            return refuse("locked", NOT_SET_UP);
        }
        const widening = settingsWidening(this.settings(), patchedSettings(this.settings(), patch));
        const opened = await this.vault.open(file, {
            title: "Change what Passwords remembers?",
            message: widening.length === 0 ? "This change only lets Passwords remember less." : `This change ${widening.join("; ")}.`,
            person: widening.length > 0,
        });
        if ("ok" in opened) {
            return opened;
        }
        const current = settingsOf(opened.doc);
        const next = patchedSettings(current, patch);
        // The open part may have understated what is on file: what the person was not asked about must not widen anything.
        if (!opened.asked && settingsWidening(current, next).length > 0) {
            return refuse("declined", "The settings on file differ from what this change was judged against: ask again.");
        }
        if (patch.remember !== undefined && next.rememberAskedAt === undefined) {
            next.rememberAskedAt = this.vault.deps.now();
        }
        const settings = KeyringSettingsSchema.parse(next);
        await this.vault.commit({ doc: { ...opened.doc, settings }, key: opened.key });
        await this.vault.record({ op: "set-settings", outcome: "done", asked: opened.asked, reason: widening.join("; ") });
        return { ok: true, settings };
    }

    async activity(name: string | undefined, limit: number): Answer<"activity"> {
        const lines = (await this.vault.deps.audit.lines?.()) ?? [];
        return { ok: true, lines: activityOf(lines, name, limit) };
    }

    candidates(origin: KeyringOrigin): KeyringResponse<"candidates"> {
        const matches = entriesFor(this.#shown().map(candidateOf), origin).map((match) => {
            const row: CandidateRow = { name: match.name, title: match.title ?? match.name };
            if (match.username !== undefined) {
                row.username = match.username;
            }
            return row;
        });
        return { ok: true, matches };
    }

    async fillValue(origin: KeyringOrigin, name: string): Answer<"fill-value"> {
        const file = this.vault.file();
        const shown = this.#entry(name);
        if (file === undefined || shown === undefined || !rulesServe(candidateOf(shown).rules, origin)) {
            return refuse("unknown", `${name} is not saved for ${placeWords(origin)}.`);
        }
        const opened = await this.vault.open(file, { title: `Fill ${titleOf(shown)} on ${placeWords(origin)}?`, message: `Your browser asks to fill ${titleOf(shown)}${shown.username === undefined ? "" : ` (${shown.username})`} on ${placeWords(origin)}.`, person: true });
        if ("ok" in opened) {
            return opened;
        }
        const entry = opened.doc.entries[name];
        // Judged again on the rules on file, which a rewritten open part cannot loosen.
        if (entry === undefined || entry.deleted === true || !rulesServe(candidateOf(entryInfoOf(entry)).rules, origin)) {
            return refuse("unknown", `${name} is not saved for ${placeWords(origin)}.`);
        }
        const value = await this.vault.valueOf(opened.doc, entry);
        if (!value.ok) {
            return value;
        }
        await this.vault.commit({ doc: withEntry(opened.doc, usedEntry(entry, this.vault.deps.now())), key: opened.key });
        await this.vault.record({ op: "fill", outcome: "granted", secret: name, target: placeWords(origin), asked: true, how: opened.how });
        return withUsername({ ok: true, value: value.value }, entry.rules.username);
    }
}

const withUsername = <T extends { ok: true; value: string; username?: string }>(answer: T, username: string | undefined): T => {
    if (username !== undefined) {
        answer.username = username;
    }
    return answer;
};

const historyValue = (entry: StoredEntry, version: number): { ok: true; value: string } | ReturnType<typeof refuse> => {
    const item = entry.history?.[version];
    return item === undefined ? refuse("unknown", `${entry.name} has no earlier password ${String(version)}.`) : { ok: true, value: item.value };
};

/** An entry with its earlier value `version` put back and the one it had kept in its history. Pure. */
const restoredEntry = (entry: StoredEntry, version: number, now: number, revision: number): StoredEntry | undefined => {
    const history = entry.history ?? [];
    const item = history[version];
    if (item === undefined || entry.value === undefined) {
        return undefined;
    }
    const kept = [{ value: entry.value, at: entry.updatedAt }, ...history.filter((_other, index) => index !== version)].slice(0, HISTORY_MAX);
    return { ...entry, value: item.value, history: kept, updatedAt: now, revision };
};
