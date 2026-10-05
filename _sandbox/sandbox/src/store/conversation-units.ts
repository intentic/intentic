import { mkdir, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import { join, relative } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { isConversationId } from "@intentic/sandbox-contract";

// One directory per conversation on the history volume, holding every file the daemon keeps for it; each file's owner
// names it inside (its transcript, what it was last told, a fenced conversation's own runtime store). Removing the
// directory removes all of them, whatever they are, so nothing here lists them.

export const conversationsRoot = (historyRoot: string): string => join(historyRoot, "conversations");

// Where the boot sweep moves a directory no conversation row owns, instead of deleting it: under the history volume's
// trash, which the Storage view lists, kept long enough for a person to notice a conversation that went missing.
// Named `<id>`, or `<id>.<ms>` beside an earlier one of the same id, so moving one back is a rename.
export const quarantineRoot = (historyRoot: string): string => join(historyRoot, "trash", "conversations");

// How long a set-aside directory is kept before the sweep removes it for good.
export const QUARANTINE_MS = 14 * 24 * 60 * 60_000;

// Throws on anything that is not a conversation id, the guard every path built from one relies on.
export const conversationUnit = (historyRoot: string, id: string): string => {
    if (!isConversationId(id)) {
        throw new Error(`not a conversation id: ${JSON.stringify(id)}`);
    }
    return join(conversationsRoot(historyRoot), id);
};

// Every set-aside directory, absolute: the blob sweep reads the records they hold as names still standing, since a
// directory moved back must find its tool outputs where it left them.
export const quarantinedUnits = async (historyRoot: string): Promise<string[]> => {
    const root = quarantineRoot(historyRoot);
    const entries = (await readdir(root, { withFileTypes: true }).catch(undefinedIfMissing)) ?? [];
    return entries.filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name));
};

// What the sweep asks of the conversation database.
export interface UnitOwners {
    // Whether a row exists for the conversation, readable by this build or not: a row it cannot read still owns its
    // directory.
    readonly has: (id: string) => boolean;
    // Whether the database holds any conversation at all.
    readonly any: () => boolean;
    // Set when this boot found the database missing or damaged and made it again (conversations-db-recovery.ts): its
    // rows are not the ones the directories were written beside.
    readonly recreated: boolean;
}

// What one sweep did. `held` names why it moved nothing: the database cannot be trusted to name every conversation, and
// taking its silence as orphans is how a lost database would take every transcript with it.
export interface UnitSweep {
    readonly held?: "database-recreated" | "database-empty";
    // Directories no row owns, moved aside this pass.
    readonly quarantined: readonly string[];
    // Set-aside directories past QUARANTINE_MS, removed for good this pass; the records they held went with them.
    readonly pruned: readonly string[];
}

export interface ConversationUnits {
    readonly dir: (id: string) => string;
    // Each conversation's directory, whole.
    readonly remove: (ids: readonly string[]) => Promise<void>;
    // Moves the directories no registered conversation owns aside, and removes what was moved aside long enough ago.
    readonly sweep: (now: number) => Promise<UnitSweep>;
    // Only the second half of `sweep`, under the same holds: what the hourly trash sweep runs
    // (system/resources/storage/trash-sweep.ts), since moving directories aside is the boot's call alone. `quarantined`
    // is always empty.
    readonly prune: (now: number) => Promise<UnitSweep>;
    // What the database answers about which conversations exist, for another sweep judging a directory by its owner
    // (conversations/worktrees/orphan-checkouts.ts) with the same distrust of a database made again this boot.
    readonly owners: UnitOwners;
    // The first `limit` files under one conversation's directory, relative to it, and how many there are in all.
    readonly files: (
        id: string,
        limit: number,
    ) => Promise<{ readonly files: { readonly path: string; readonly bytes: number }[]; readonly total: number }>;
}

// Younger than this, a directory without a conversation is one being opened: a fork copies its transcript before the
// turn that registers it begins. A hang bound on that gap, far above the slow case.
const OPENING_GRACE_MS = 60 * 60_000;

// Every conversation's directory by id, whatever the database says of it.
const unitIds = async (historyRoot: string): Promise<string[]> =>
    ((await readdir(conversationsRoot(historyRoot), { withFileTypes: true }).catch(undefinedIfMissing)) ?? [])
        .filter((entry) => entry.isDirectory() && isConversationId(entry.name))
        .map((entry) => entry.name);

// The directory's own mtime, stamped when it is set aside, is when it was; nothing writes inside one after that.
const stampedAt = (path: string, fallback: number): Promise<number> =>
    stat(path).then(
        (info) => info.mtimeMs,
        () => fallback,
    );

const quarantine = async (historyRoot: string, id: string, now: number): Promise<void> => {
    const root = quarantineRoot(historyRoot);
    await mkdir(root, { recursive: true });
    const taken = await stat(join(root, id)).then(
        () => true,
        () => false,
    );
    const target = join(root, taken ? `${id}.${String(now)}` : id);
    await rename(conversationUnit(historyRoot, id), target);
    const at = new Date(now);
    await utimes(target, at, at);
};

const pruneQuarantine = async (historyRoot: string, now: number): Promise<string[]> => {
    const pruned: string[] = [];
    for (const dir of await quarantinedUnits(historyRoot)) {
        if (now - (await stampedAt(dir, now)) > QUARANTINE_MS) {
            await rm(dir, { recursive: true, force: true });
            pruned.push(relative(quarantineRoot(historyRoot), dir));
        }
    }
    return pruned;
};

// Why nothing may be set aside or removed right now, given the directories standing; undefined when nothing holds.
const holdOf = (owners: UnitOwners, ids: readonly string[]): UnitSweep["held"] => {
    if (owners.recreated) {
        return "database-recreated";
    }
    return ids.length > 0 && !owners.any() ? "database-empty" : undefined;
};

export const conversationUnits = (historyRoot: string, owners: UnitOwners): ConversationUnits => ({
    dir: (id) => conversationUnit(historyRoot, id),
    remove: async (ids) => {
        await Promise.all(ids.map((id) => rm(conversationUnit(historyRoot, id), { recursive: true, force: true })));
    },
    sweep: async (now) => {
        const ids = await unitIds(historyRoot);
        const held = holdOf(owners, ids);
        if (held !== undefined) {
            return { held, quarantined: [], pruned: [] };
        }
        const quarantined: string[] = [];
        for (const id of ids) {
            // Asked at the decision, since this runs behind boot while conversations are being opened.
            if (owners.has(id)) {
                continue;
            }
            if (now - (await stampedAt(conversationUnit(historyRoot, id), now)) < OPENING_GRACE_MS) {
                continue;
            }
            await quarantine(historyRoot, id, now);
            quarantined.push(id);
        }
        return { quarantined, pruned: await pruneQuarantine(historyRoot, now) };
    },
    prune: async (now) => {
        const held = holdOf(owners, await unitIds(historyRoot));
        return held !== undefined ? { held, quarantined: [], pruned: [] } : { quarantined: [], pruned: await pruneQuarantine(historyRoot, now) };
    },
    owners,
    files: async (id, limit) => {
        const dir = conversationUnit(historyRoot, id);
        const found = (await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []))
            .filter((entry) => entry.isFile())
            .map((entry) => join(entry.parentPath, entry.name))
            .toSorted();
        const files = await Promise.all(found.slice(0, limit).map(async (path) => ({ path: relative(dir, path), bytes: (await stat(path)).size })));
        return { files, total: found.length };
    },
});
