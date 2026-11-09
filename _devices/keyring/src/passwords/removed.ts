import type { KeyringResponse, RemovedInfo } from "../protocol.js";
import { type StoredEntry, TRASH_KEEP_MS, TRASH_MAX, type TrashedEntry, type VaultDocument } from "../vault.js";
import { type Answer, NOT_SET_UP, refuse, type VaultAccess } from "./access.js";
import { entryInfoOf, titleOf, withEntry } from "./entries.js";

// RECENTLY DELETED (2026-11-09). Removing a password narrows where it may go, as an edit that drops a place does, so it
// asks nobody while the vault is unlocked: what makes that safe is that it can be taken back. The entry leaves the list
// and every sandbox at once (a tombstone in `entries`, which is also what a paired keyring is told), and is kept as it
// was, value, history and shares included, in the inner document's `trash` for TRASH_KEEP_MS. Putting it back asks
// nobody either; forgetting it for good, the one step that cannot be undone, asks the person.

const live = (item: { readonly removedAt: number }, now: number): boolean => now - item.removedAt < TRASH_KEEP_MS;

/** `doc` with `entry` kept in Recently deleted from `now`: an earlier removal of the same name and anything past its time dropped. Pure. */
export const withTrashed = (doc: VaultDocument, entry: StoredEntry, now: number): VaultDocument => {
    const others = (doc.trash ?? []).filter((item) => item.entry.name !== entry.name && live(item, now));
    return { ...doc, trash: [{ entry, removedAt: now }, ...others].slice(0, TRASH_MAX) };
};

/** `doc` without what has been in Recently deleted longer than it is kept. Pure. */
export const withoutExpired = (doc: VaultDocument, now: number): VaultDocument => (doc.trash === undefined ? doc : { ...doc, trash: doc.trash.filter((item) => live(item, now)) });

/** What the open part says of Recently deleted: names and rules, never a value. Pure. */
export const removedInfoOf = (trash: readonly TrashedEntry[]): RemovedInfo[] => trash.map((item) => ({ entry: entryInfoOf(item.entry), removedAt: item.removedAt }));

const days = Math.round(TRASH_KEEP_MS / (24 * 60 * 60 * 1000));

export class RecentlyDeleted {
    constructor(private readonly vault: VaultAccess) {}

    /** Newest first, from the open part, so it answers while locked. */
    items(): RemovedInfo[] {
        const now = this.vault.deps.now();
        return (this.vault.file()?.open.trash ?? []).filter((item) => live(item, now)).toSorted((a, b) => b.removedAt - a.removedAt);
    }

    list(): KeyringResponse<"recently-deleted"> {
        return { ok: true, items: this.items() };
    }

    async remove(name: string): Answer<"remove"> {
        const file = this.vault.file();
        const shown = file?.open.entries.find((entry) => entry.name === name);
        if (file === undefined || shown === undefined) {
            return refuse("unknown", `The keyring has no entry named ${name}.`);
        }
        // Narrowing: asked only when the vault is locked, since writing needs it open.
        const opened = await this.vault.open(file, {
            title: `Remove ${titleOf(shown)} from Passwords?`,
            message: `It goes to Recently deleted for ${String(days)} days, where you can put it back. Until then no sandbox can use it, and a paired keyring removes it too.`,
            person: false,
        });
        if ("ok" in opened) {
            return opened;
        }
        const entry = opened.doc.entries[name];
        if (entry === undefined || entry.deleted === true) {
            return refuse("unknown", `The keyring has no entry named ${name}.`);
        }
        const now = this.vault.deps.now();
        const tombstone: StoredEntry = { name, rules: entry.rules, source: entry.source, shares: [], createdAt: entry.createdAt, updatedAt: now, revision: opened.doc.revision + 1, deleted: true };
        await this.vault.commit({ doc: withTrashed(withEntry(opened.doc, tombstone), entry, now), key: opened.key });
        await this.vault.record({ op: "remove", outcome: "done", secret: name, asked: opened.asked });
        return { ok: true };
    }

    async undo(name: string): Answer<"undo-remove"> {
        const file = this.vault.file();
        if (file === undefined) {
            return refuse("locked", NOT_SET_UP);
        }
        const shown = this.items().find((item) => item.entry.name === name);
        if (shown === undefined) {
            return refuse("unknown", `Nothing named ${name} is in Recently deleted.`);
        }
        if (file.open.entries.some((entry) => entry.name === name)) {
            return refuse("declined", `A password named ${name} is in Passwords again. Remove that one first, then put this one back.`);
        }
        const opened = await this.vault.open(file, { title: `Put ${titleOf(shown.entry)} back?`, message: "It comes back as it was, with the agents that could use it.", person: false });
        if ("ok" in opened) {
            return opened;
        }
        const doc = opened.doc;
        const trashed = doc.trash?.find((item) => item.entry.name === name);
        const now = this.vault.deps.now();
        if (trashed === undefined || !live(trashed, now)) {
            return refuse("unknown", `Nothing named ${name} is in Recently deleted.`);
        }
        const current = doc.entries[name];
        if (current !== undefined && current.deleted !== true) {
            return refuse("declined", `A password named ${name} is in Passwords again. Remove that one first, then put this one back.`);
        }
        // Changed now, so it is newer than its tombstone and a paired keyring takes it back as well.
        const restored: StoredEntry = { ...trashed.entry, updatedAt: now, revision: doc.revision + 1 };
        await this.vault.commit({ doc: { ...withEntry(doc, restored), trash: (doc.trash ?? []).filter((item) => item !== trashed) }, key: opened.key });
        await this.vault.record({ op: "undo-remove", outcome: "done", secret: name, asked: opened.asked });
        return { ok: true };
    }

    /** One removed entry forgotten for good, or every one with no `name`. */
    async purge(name: string | undefined): Answer<"purge"> {
        const file = this.vault.file();
        if (file === undefined) {
            return refuse("locked", NOT_SET_UP);
        }
        const listed = this.items();
        const shown = name === undefined ? undefined : listed.find((item) => item.entry.name === name);
        if (name !== undefined && shown === undefined) {
            return refuse("unknown", `Nothing named ${name} is in Recently deleted.`);
        }
        if (listed.length === 0) {
            return { ok: true, purged: 0 };
        }
        const opened = await this.vault.open(file, {
            title: shown === undefined ? "Empty Recently deleted?" : `Delete ${titleOf(shown.entry)} for good?`,
            message:
                shown === undefined
                    ? `${String(listed.length)} removed ${listed.length === 1 ? "password is" : "passwords are"} deleted for good. This can't be undone.`
                    : "It can't be put back after this.",
            person: true,
        });
        if ("ok" in opened) {
            return opened;
        }
        const before = opened.doc.trash ?? [];
        const kept = name === undefined ? [] : before.filter((item) => item.entry.name !== name);
        await this.vault.commit({ doc: { ...opened.doc, trash: kept }, key: opened.key });
        await this.vault.record({ op: "purge", outcome: "done", secret: name, asked: opened.asked });
        return { ok: true, purged: before.length - kept.length };
    }
}
