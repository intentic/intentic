import { copyFileSync, existsSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { IN_MEMORY } from "@intentic/base/sqlite";
import { errorMessage } from "@intentic/base/errors";
import { HISTORY_ROOT } from "@intentic/constants";
import { isConversationId } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { conversationsRoot } from "./conversation-units.js";
import {
    type ConversationsDb,
    conversationsDbPath,
    ConversationsUpgradeError,
    damageIn,
    openCheckedConversationsDb,
    openConversationsDb,
} from "./conversations-db.js";
import { type ManifestProblem, recordStandingProblem } from "./manifest/manifest-problems.js";

// How the daemon opens its conversation database at boot, where a file that is missing or damaged must never keep it
// from coming up: every conversation, and every door that reaches one, is behind this file. What it finds wrong it
// works around without deleting anything, logs, and reports to the owner as a problem with the whole file
// (manifest-problems.ts). The orphan sweep holds off for the boot after any of it (conversation-units.ts), since a
// database made again does not name the conversations whose directories are on the volume.
//
// The one failure it does not work around is a sound file this build could not upgrade (ConversationsUpgradeError):
// setting it aside would tell the owner a healthy database was damaged and run this build without it, when the fault is
// the build's. That boot fails instead (system/boot/boot-failure.ts): the front restarts it with backoff, the host reads
// why, and an update on probation is put back on the version before it, which reads the file as it was.

// What opening found and did, when the file was not simply there and sound.
export type ConversationsDbRecovery =
    // Gone while conversation directories remained: an empty database was made in its place.
    | { readonly kind: "missing"; readonly directories: number }
    // It failed to open or to pass the check: set aside, and what still read of it copied into a new file.
    | { readonly kind: "salvaged"; readonly aside: string; readonly reason: string; readonly conversations: number }
    // As above, with nothing that could be copied: set aside, and an empty database made in its place.
    | { readonly kind: "replaced"; readonly aside: string; readonly reason: string; readonly salvage: string }
    // Not even a new file could be made (the volume refused the write): this run keeps its rows in memory.
    | { readonly kind: "memory"; readonly reason: string };

export interface OpenedConversationsDb {
    readonly db: ConversationsDb;
    readonly recovery: ConversationsDbRecovery | undefined;
}

export interface BootOpen {
    readonly historyRoot: string;
    // Whether the previous run died without its exit hook (system/boot/boot-marker.ts), the one time damage is worth
    // looking for before anything reads the file; otherwise a damaged file is found by failing to open.
    readonly check: boolean;
    readonly logger: Pick<Logger, "error">;
    readonly now?: () => number;
}

// The database file's own name beside its two sidecars, which a copy or a move must take together: a WAL database is
// the three of them.
const SIDECARS = ["-wal", "-shm"] as const;

// Directories on the volume a conversation owned, whatever the database says.
const directoriesOn = (historyRoot: string): number => {
    try {
        return readdirSync(conversationsRoot(historyRoot), { withFileTypes: true }).filter((entry) => entry.isDirectory() && isConversationId(entry.name)).length;
    } catch {
        // allow(silent-catch): no directory there is exactly a volume with no conversations on it
        return 0;
    }
};

// Moves the file and its sidecars aside under one name, the sidecars first so that a failure never leaves a stale WAL
// beside the new file. The sidecars keep their suffixes, so the set-aside copy opens as the database it was. A file
// that will not move takes its sidecars back, so it is never parted from its log.
const setAside = (path: string, at: number): string => {
    const aside = `${path}.corrupt-${String(at)}`;
    const moved = SIDECARS.filter((suffix) => existsSync(`${path}${suffix}`));
    for (const suffix of moved) {
        renameSync(`${path}${suffix}`, `${aside}${suffix}`);
    }
    try {
        renameSync(path, aside);
    } catch (error) {
        for (const suffix of moved) {
            renameSync(`${aside}${suffix}`, `${path}${suffix}`);
        }
        throw error;
    }
    return aside;
};

const removeScratch = (paths: readonly string[]): void => {
    for (const path of paths) {
        rmSync(path, { force: true });
    }
};

// Copies what still reads of the set-aside database into a new file at `path`, answering why it could not. Worked on a
// scratch copy, so the set-aside bytes stay exactly as they were found. VACUUM INTO writes every table and index anew,
// which gets past damage outside them (a miscounted free list, pages nothing uses) but not a damaged table or index
// page, and the copy must pass the check before it takes the database's place.
const salvage = (aside: string, path: string): string | undefined => {
    const scratch = `${path}.salvaging`;
    const copy = `${path}.salvaged`;
    const leftovers = [scratch, ...SIDECARS.map((suffix) => `${scratch}${suffix}`), copy];
    removeScratch(leftovers);
    try {
        copyFileSync(aside, scratch);
        if (existsSync(`${aside}-wal`)) {
            copyFileSync(`${aside}-wal`, `${scratch}-wal`);
        }
        const source = new DatabaseSync(scratch);
        try {
            source.prepare("VACUUM INTO ?").run(copy);
        } finally {
            source.close();
        }
        const copied = new DatabaseSync(copy);
        let damage: string | undefined;
        try {
            damage = damageIn(copied);
        } finally {
            copied.close();
        }
        if (damage !== undefined) {
            return `the copy failed the integrity check too: ${damage}`;
        }
        renameSync(copy, path);
        return undefined;
    } catch (error) {
        return errorMessage(error);
    } finally {
        removeScratch(leftovers);
    }
};

const conversationCount = (db: ConversationsDb): number => {
    // SAFETY: an aggregate with no GROUP BY answers exactly one row, its one column the integer the alias names.
    const row = db.db.prepare("SELECT count(*) AS count FROM conversation").get() as { count: number };
    return row.count;
};

// A file of no bytes is no database: what a crash between creating the file and its first write leaves, read as gone.
const absent = (path: string): boolean => !existsSync(path) || statSync(path).size === 0;

const openOnDisk = (path: string, historyRoot: string, check: boolean, now: () => number): OpenedConversationsDb => {
    if (absent(path)) {
        const directories = directoriesOn(historyRoot);
        return { db: openConversationsDb(path), recovery: directories > 0 ? { kind: "missing", directories } : undefined };
    }
    let reason: string;
    try {
        return { db: openCheckedConversationsDb(path, check), recovery: undefined };
    } catch (error) {
        if (error instanceof ConversationsUpgradeError) {
            throw error;
        }
        reason = errorMessage(error);
    }
    const aside = setAside(path, now());
    const failed = salvage(aside, path);
    const db = openConversationsDb(path);
    return {
        db,
        recovery: failed === undefined ? { kind: "salvaged", aside, reason, conversations: conversationCount(db) } : { kind: "replaced", aside, reason, salvage: failed },
    };
};

// How the owner is told, as the report names the file: by its path on the daemon's volume.
const volumePath = (path: string): string => `${HISTORY_ROOT}/${basename(path)}`;

const problemOf = (recovery: ConversationsDbRecovery): ManifestProblem => {
    switch (recovery.kind) {
        case "missing":
            return {
                kind: "unreadable",
                reason: "io",
                detail: `It was missing while ${String(recovery.directories)} conversations' folders were still on the volume, so an empty one was made.`,
                fix: "Their folders are kept as they are. To list those conversations again, stop the sandbox and put the missing database back.",
            };
        case "salvaged":
            return {
                kind: "unreadable",
                reason: "io",
                detail: `It was damaged (${recovery.reason}), so it was set aside and the ${String(recovery.conversations)} conversations that could still be read were copied into a new one.`,
                fix: `The damaged file is kept at ${volumePath(recovery.aside)}: a conversation missing from the list may still be in it.`,
            };
        case "replaced":
            return {
                kind: "unreadable",
                reason: "io",
                detail: `It was damaged (${recovery.reason}) and nothing could be copied out of it, so it was set aside and an empty one was made.`,
                fix: `The damaged file is kept at ${volumePath(recovery.aside)}, and every conversation's folder stays on the volume.`,
            };
        case "memory":
            return {
                kind: "unreadable",
                reason: "io",
                detail: `It could not be opened or made again (${recovery.reason}), so this run keeps its conversations in memory and loses them when it stops.`,
                fix: "Make sure the sandbox's history volume is writable and has room, then restart the sandbox.",
            };
    }
};

// Throws only ConversationsUpgradeError, for a sound file this build could not upgrade; for anything else the last resort
// is a database in memory, which serves this run and keeps nothing.
export const openConversationsDbAtBoot = ({ historyRoot, check, logger, now = Date.now }: BootOpen): OpenedConversationsDb => {
    const path = conversationsDbPath(historyRoot);
    let opened: OpenedConversationsDb;
    try {
        opened = openOnDisk(path, historyRoot, check, now);
    } catch (error) {
        if (error instanceof ConversationsUpgradeError) {
            throw error;
        }
        opened = { db: openConversationsDb(IN_MEMORY), recovery: { kind: "memory", reason: errorMessage(error) } };
    }
    if (opened.recovery !== undefined) {
        logger.error({ recovery: opened.recovery, path }, "conversations: the database was not as the last run left it; nothing was deleted");
        recordStandingProblem(path, problemOf(opened.recovery));
    }
    return opened;
};
