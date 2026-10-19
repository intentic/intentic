import { entryNameFor, findCaptureTarget, originKey, rememberSwitchFor, REMEMBER_NOTHING, rulesForOrigin, titleForOrigin } from "@intentic/sandbox-contract/policy/keyring-origins";
import type { KeyringCaptureItem, KeyringCaptureOutcome, KeyringCaptureResult } from "@intentic/sandbox-contract/schemas/keyring";
import { seal, unseal } from "@intentic/sandbox-contract/keyring-seal";
import { type Answer, NOT_SET_UP, type Opened, refuse, type ValueRead, type VaultAccess } from "./access.js";
import { candidateOf, entryInfoOf, liveEntries, settingsOf, titleOf, withEntry } from "./entries.js";
import type { CapturedInfo, EntryRules } from "../protocol.js";
import { type HistoryItem, HISTORY_MAX, type PendingCapture, PENDING_CAPTURES_MAX, type StoredEntry, UNDO_MAX, type UndoRecord, VALUE_MAX_BYTES, type VaultDocument } from "../vault.js";

// CAPTURE: a credential seen in use (a browser's sign-in, an ssh prompt answered once, git's credential helper, the
// phone's autofill, a sandbox terminal's hidden prompt) taken into the vault without asking anyone, once the person
// turned remembering on for where it came from. Bringing a value IN reveals nothing, and nothing it replaces is lost:
// an update keeps the old value in the entry's history, and for ten minutes the notice's Undo takes the whole capture
// back. While locked the item waits sealed in the open part and the next unlock takes it in. A capture's value is never
// shared with a sandbox by itself: sharing is always a separate yes.

// What a capture may arrive as, and from where. A sandbox speaks only for its phone and its terminals; an import comes
// as a batch the person said yes to, and an agent's typed-once value through a need.
const RELAYED_SOURCES = new Set<KeyringCaptureItem["source"]>(["phone", "terminal"]);
const BATCH_ONLY = new Set<KeyringCaptureItem["source"]>(["import", "agent"]);
// Seen in use but not yet seen to work: replaced outright if the next capture says it failed.
const UNVERIFIED_SOURCES = new Set<KeyringCaptureItem["source"]>(["browser", "askpass", "app", "phone", "terminal"]);

// A same-user program could otherwise fill the vault and its history with junk.
const RATE_PER_MINUTE = 60;
export const UNDO_WINDOW_MS = 10 * 60_000;

export interface CaptureFacts {
    readonly now: number;
    // The person ticked "Remember it" in the keyring's own box: no switch is needed for that one.
    readonly deliberate?: boolean | undefined;
}

export interface Applied {
    readonly doc: VaultDocument;
    readonly outcome: KeyringCaptureOutcome;
    readonly name?: string | undefined;
    readonly title?: string | undefined;
}

const skipped = (doc: VaultDocument): Applied => ({ doc, outcome: "skipped" });

const withUndo = (doc: VaultDocument, record: UndoRecord, now: number): VaultDocument => ({
    ...doc,
    undo: [...(doc.undo ?? []).filter((kept) => now - kept.doneAt < UNDO_WINDOW_MS && !(kept.name === record.name && kept.at === record.at)), record].slice(-UNDO_MAX),
});

const capturedOf = (item: CaptureDraft): CapturedInfo => ({ source: item.source, via: item.via, at: item.at });

// The fields a capture sets on an entry it made or changed.
const capturedFields = (item: CaptureDraft, now: number): Pick<StoredEntry, "captured" | "fresh" | "updatedAt"> & { unverified?: true } => {
    const fields = { captured: capturedOf(item), fresh: true, updatedAt: now };
    return UNVERIFIED_SOURCES.has(item.source) ? { ...fields, unverified: true } : fields;
};

const withoutFlags = (entry: StoredEntry): StoredEntry => {
    const { unverified: _unverified, failed: _failed, ...rest } = entry;
    return rest;
};

const historyOf = (entry: StoredEntry, value: string): HistoryItem => {
    const item: HistoryItem = { value, at: entry.updatedAt };
    if (entry.captured !== undefined) {
        item.captured = entry.captured;
    }
    return item;
};

const updatedEntry = (entry: StoredEntry, item: CaptureDraft, value: string, revision: number, now: number): StoredEntry => {
    const replace = item.failed === true || entry.failed === true;
    const earlier = entry.value === undefined || replace ? (entry.history ?? []) : [historyOf(entry, entry.value), ...(entry.history ?? [])];
    const username = entry.rules.username ?? item.username;
    const rules = username === undefined ? entry.rules : { ...entry.rules, username };
    return { ...withoutFlags(entry), rules, value, history: earlier.slice(0, HISTORY_MAX), revision, ...capturedFields(item, now) };
};

const newEntry = (doc: VaultDocument, item: CaptureDraft, value: string, now: number): StoredEntry => {
    const title = titleForOrigin(item.origin, item.title);
    const username = item.username?.trim() === "" ? undefined : item.username;
    const taken = new Set(liveEntries(doc).map((entry) => entry.name));
    const name = entryNameFor(title, username, (candidate) => taken.has(candidate));
    const placed = rulesForOrigin(item.origin);
    const rules: EntryRules = {
        kind: item.kind,
        programs: [...placed.programs],
        packages: [...placed.packages],
        hosts: [...placed.hosts],
        askpass: [...placed.askpass],
        anyField: false,
        askpassRememberMinutes: 0,
        title,
    };
    if (username !== undefined) {
        rules.username = username;
    }
    return {
        name,
        rules,
        source: "keyring",
        value,
        shares: [],
        createdAt: now,
        revision: doc.revision + 1,
        ...capturedFields(item, now),
    };
};

/**
 * One capture applied to the inner document: skipped when its source's switch is off (unless the person ticked Remember
 * in the keyring's own box) or its place is never saved for; the same value is unchanged; another value updates the
 * entry for that place and account; none is a new entry. Pure.
 */
export const applyCapture = (doc: VaultDocument, item: CaptureDraft, value: string, facts: CaptureFacts): Applied => {
    const settings = settingsOf(doc);
    const toggle = rememberSwitchFor(item.source);
    if ((facts.deliberate !== true && toggle !== undefined && !settings.remember[toggle]) || settings.neverSave.some((origin) => originKey(origin) === originKey(item.origin))) {
        return skipped(doc);
    }
    const live = liveEntries(doc);
    const target = findCaptureTarget(live.map((entry) => candidateOf(entryInfoOf(entry))), item.origin, item.username);
    const entry = target === undefined ? undefined : doc.entries[target.name];
    if (entry === undefined) {
        const made = newEntry(doc, item, value, facts.now);
        return { doc: withUndo(withEntry(doc, made), { name: made.name, at: item.at, doneAt: facts.now }, facts.now), outcome: "saved", name: made.name, title: made.rules.title };
    }
    const title = titleOf(entryInfoOf(entry));
    // A backed entry's value is its password manager's to change.
    if (entry.backend !== undefined) {
        return { doc, outcome: "skipped", name: entry.name, title };
    }
    if (entry.value === value) {
        // git calls `store` only after the value worked, so a git capture of the same value proves it.
        const proved = item.source === "git" && (entry.unverified === true || entry.failed === true);
        return { doc: proved ? withEntry(doc, withoutFlags(entry)) : doc, outcome: "unchanged", name: entry.name, title };
    }
    const changed = updatedEntry(entry, item, value, doc.revision + 1, facts.now);
    const settled = item.source === "git" ? withoutFlags(changed) : changed;
    return { doc: withUndo(withEntry(doc, settled), { name: entry.name, at: item.at, doneAt: facts.now, before: entry }, facts.now), outcome: "updated", name: entry.name, title };
};

/** A capture taken back: the entry it made removed, or the one it changed put back as it was. Pure. */
const undoCapture = (doc: VaultDocument, name: string, at: number, now: number): VaultDocument | undefined => {
    const record = (doc.undo ?? []).find((kept) => kept.name === name && kept.at === at && now - kept.doneAt <= UNDO_WINDOW_MS);
    const entry = doc.entries[name];
    if (record === undefined || entry === undefined) {
        return undefined;
    }
    const revision = doc.revision + 1;
    const back: StoredEntry =
        record.before === undefined
            ? { name, rules: entry.rules, source: entry.source, shares: [], createdAt: entry.createdAt, updatedAt: now, revision, deleted: true }
            : { ...record.before, updatedAt: now, revision };
    return { ...withEntry(doc, back), undo: (doc.undo ?? []).filter((kept) => kept !== record) };
};

// An item as the core takes it in, the value opened from the inbox it was sealed to.
export const openedValue = (doc: VaultDocument, item: Pick<KeyringCaptureItem, "sealed" | "via" | "at">): ValueRead => {
    let value: string;
    try {
        value = unseal(doc.inbox, item.sealed, { kind: "capture", via: item.via, at: item.at });
    } catch {
        return refuse("bad-grant", "The value was not sealed to this keyring's inbox for this capture.");
    }
    return Buffer.byteLength(value, "utf8") > VALUE_MAX_BYTES ? refuse("bad-grant", `A value holds at most ${String(VALUE_MAX_BYTES / 1024)} KiB.`) : { ok: true, value };
};

// The pipe's answer for what a capture did.
const answerOf = (applied: Kept): KeyringCaptureResult => {
    const answer: Extract<KeyringCaptureResult, { ok: true }> = { ok: true, outcome: applied.outcome };
    if (applied.name !== undefined) {
        answer.name = applied.name;
    }
    if (applied.title !== undefined) {
        answer.title = applied.title;
    }
    return answer;
};

export type CaptureDraft = Omit<KeyringCaptureItem, "sealed">;

export interface Kept {
    readonly outcome: KeyringCaptureOutcome;
    readonly name?: string | undefined;
    readonly title?: string | undefined;
}

export class Captures {
    readonly #times: number[] = [];

    constructor(private readonly vault: VaultAccess) {}

    #limited(now: number): boolean {
        while (this.#times.length > 0 && now - (this.#times[0] ?? now) >= 60_000) {
            this.#times.shift();
        }
        if (this.#times.length >= RATE_PER_MINUTE) {
            return true;
        }
        this.#times.push(now);
        return false;
    }

    // ---- the pipe's `capture` ----

    async capture(asked: KeyringCaptureItem, sandbox: string | undefined): Answer<"capture"> {
        const file = this.vault.file();
        if (file === undefined) {
            return refuse("locked", NOT_SET_UP);
        }
        if (sandbox !== undefined && !RELAYED_SOURCES.has(asked.source)) {
            return refuse("bad-grant", `A sandbox sends captures only from a phone or a terminal, not as ${asked.source}.`);
        }
        if (sandbox === undefined && BATCH_ONLY.has(asked.source)) {
            return refuse("bad-grant", `A capture from ${asked.source} comes as an import or an agent's need, not on its own.`);
        }
        const now = this.vault.deps.now();
        if (this.#limited(now)) {
            return refuse("busy", "Too many passwords arrived in the last minute: the rest wait for the next.");
        }
        // A sandbox terminal's prompt is filed under the sandbox it was seen in, whatever the item says.
        const item: KeyringCaptureItem = asked.origin.kind === "prompt" && sandbox !== undefined ? { ...asked, origin: { ...asked.origin, sandbox } } : asked;
        const held = this.vault.held();
        if (held !== undefined) {
            return await this.#into(held, item, sandbox, false);
        }
        // Added by hand from the app: the person is there, so the vault opens for it rather than keeping it waiting.
        if (item.source === "manual") {
            const opened = await this.vault.open(file, { title: `Save ${titleForOrigin(item.origin, item.title)}?`, message: "Passwords is locked: unlock it to save this password.", person: true });
            return "ok" in opened ? opened : await this.#into(opened, item, sandbox, false);
        }
        const toggle = rememberSwitchFor(item.source);
        // The open part's copy of the switches only says whether to keep the item; the inner one decides at take-in.
        if (toggle !== undefined && !(file.open.settings?.remember ?? REMEMBER_NOTHING)[toggle]) {
            await this.vault.record({ op: "capture", outcome: "skipped", program: item.via, sandbox });
            return { ok: true, outcome: "skipped" };
        }
        const pending: PendingCapture = { item, receivedAt: now };
        if (sandbox !== undefined) {
            pending.sandbox = sandbox;
        }
        await this.#wait(pending);
        return { ok: true, outcome: "pending" };
    }

    async #wait(pending: PendingCapture): Promise<void> {
        const file = this.vault.file();
        if (file !== undefined) {
            await this.vault.writeOpen({ ...file.open, pendingCaptures: [...(file.open.pendingCaptures ?? []), pending].slice(-PENDING_CAPTURES_MAX) });
            await this.vault.record({ op: "capture", outcome: "pending", program: pending.item.via, sandbox: pending.sandbox });
        }
    }

    async #into(opened: Pick<Opened, "doc" | "key">, item: KeyringCaptureItem, sandbox: string | undefined, deliberate: boolean): Answer<"capture"> {
        const value = openedValue(opened.doc, item);
        if (!value.ok) {
            return value;
        }
        const applied = applyCapture(opened.doc, item, value.value, { now: this.vault.deps.now(), deliberate });
        if (applied.doc !== opened.doc) {
            await this.vault.commit({ doc: applied.doc, key: opened.key });
        }
        await this.vault.record({ op: "capture", outcome: applied.outcome, secret: applied.name, program: item.via, sandbox });
        return answerOf(applied);
    }

    /**
     * A value the keyring itself was given (its type-once box, an askpass prompt it answered): kept now while unlocked,
     * or sealed to the inbox and kept waiting for the next unlock.
     */
    async keep(draft: CaptureDraft, value: string, deliberate: boolean): Promise<Kept> {
        const held = this.vault.held();
        if (held !== undefined) {
            const applied = applyCapture(held.doc, draft, value, { now: this.vault.deps.now(), deliberate });
            if (applied.doc !== held.doc) {
                await this.vault.commit({ doc: applied.doc, key: held.key });
            }
            await this.vault.record({ op: "capture", outcome: applied.outcome, secret: applied.name, program: draft.via });
            return applied;
        }
        const inbox = (await this.vault.keys()).inbox;
        if (inbox === undefined) {
            return { outcome: "skipped" };
        }
        const sealed = seal(inbox, value, { kind: "capture", via: draft.via, at: draft.at });
        const pending: PendingCapture = { item: { ...draft, sealed }, receivedAt: this.vault.deps.now() };
        if (deliberate) {
            pending.deliberate = true;
        }
        await this.#wait(pending);
        // The name it will take at the next unlock, as near as the open part can say.
        const title = titleForOrigin(draft.origin, draft.title);
        const taken = new Set(this.vault.file()?.open.entries.map((entry) => entry.name));
        return { outcome: "pending", title, name: entryNameFor(title, draft.username, (candidate) => taken.has(candidate)) };
    }

    /** What waited while locked, taken into a freshly opened document; the caller commits it with the list emptied. */
    takeIn(doc: VaultDocument, pending: readonly PendingCapture[]): VaultDocument {
        let next = doc;
        const now = this.vault.deps.now();
        for (const waiting of pending) {
            const value = openedValue(next, waiting.item);
            if (value.ok) {
                next = applyCapture(next, waiting.item, value.value, { now, deliberate: waiting.deliberate }).doc;
            }
        }
        return next;
    }

    // ---- the app's ops ----

    async batch(items: readonly KeyringCaptureItem[], from: string): Answer<"capture-batch"> {
        const file = this.vault.file();
        if (file === undefined) {
            return refuse("locked", NOT_SET_UP);
        }
        const opened = await this.vault.open(file, {
            title: `Import ${String(items.length)} passwords from ${from}?`,
            message: `Passwords keeps each one, updating the entry for the same site and account and keeping its old value in its history. None is shared with a sandbox.`,
            person: true,
        });
        if ("ok" in opened) {
            return opened;
        }
        const counts = { saved: 0, updated: 0, unchanged: 0, skipped: 0 };
        let doc = opened.doc;
        const now = this.vault.deps.now();
        for (const asked of items) {
            const item: KeyringCaptureItem = { ...asked, source: "import" };
            const value = openedValue(doc, item);
            const applied = value.ok ? applyCapture(doc, item, value.value, { now }) : skipped(doc);
            doc = applied.doc;
            counts[applied.outcome === "pending" ? "skipped" : applied.outcome]++;
        }
        await this.vault.commit({ doc, key: opened.key });
        await this.vault.record({ op: "capture-batch", outcome: "done", target: from, asked: true, reason: `${String(counts.saved)} saved, ${String(counts.updated)} updated` });
        return { ok: true, ...counts };
    }

    async undo(name: string, at: number): Answer<"undo-capture"> {
        const file = this.vault.file();
        if (file === undefined) {
            return refuse("locked", NOT_SET_UP);
        }
        const opened = await this.vault.open(file, { title: `Undo saving ${name}?`, message: "Passwords is locked: unlock it to take back what it just saved.", person: false });
        if ("ok" in opened) {
            return opened;
        }
        const undone = undoCapture(opened.doc, name, at, this.vault.deps.now());
        if (undone === undefined) {
            return refuse("unknown", `There is nothing to undo for ${name}: an Undo lasts ten minutes.`);
        }
        await this.vault.commit({ doc: undone, key: opened.key });
        await this.vault.record({ op: "undo-capture", outcome: "done", secret: name });
        return { ok: true };
    }

    // Entries looked at leave "Just saved". While locked the open part says so at once and the next unlock writes it.
    async seen(names: readonly string[]): Answer<"seen"> {
        const file = this.vault.file();
        if (file === undefined) {
            return refuse("locked", NOT_SET_UP);
        }
        const looked = new Set(names);
        const held = this.vault.held();
        if (held === undefined) {
            const entries = file.open.entries.map((entry) => (looked.has(entry.name) ? { ...entry, fresh: false } : entry));
            await this.vault.writeOpen({ ...file.open, entries, pendingSeen: [...new Set([...(file.open.pendingSeen ?? []), ...names])].slice(-5000) });
            return { ok: true };
        }
        const doc = seenIn(held.doc, looked);
        if (doc !== held.doc) {
            await this.vault.commit({ doc, key: held.key });
        }
        return { ok: true };
    }
}

/** `fresh` cleared on every entry named. Pure. */
export const seenIn = (doc: VaultDocument, names: ReadonlySet<string>): VaultDocument => {
    let next = doc;
    for (const name of names) {
        const entry = next.entries[name];
        if (entry?.fresh === true) {
            const { fresh: _fresh, ...rest } = entry;
            next = withEntry(next, rest);
        }
    }
    return next;
};
