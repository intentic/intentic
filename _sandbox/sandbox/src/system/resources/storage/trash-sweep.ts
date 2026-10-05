import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage, undefinedIfMissing } from "@intentic/base/errors";
import type { Logger } from "pino";
import { type ConversationUnits, QUARANTINE_MS, quarantineRoot } from "../../../store/conversation-units.js";
import { type Chore, DAY_MS, HOUR_MS } from "../../chore-clock.js";

// THE HISTORY VOLUME'S TRASH, EMPTIED BY AGE (2026-10-05). What the daemon sets aside instead of deleting it (a deleted
// repo's git dir, history.ts; a checkout of a repo that went, worktrees.ts; a checkout no conversation owns,
// orphan-checkouts.ts) is removed for good once it has sat there as long as a conversation's set-aside directory does,
// checked hourly. Before this only the conversations' own quarantine was ever emptied, and only at boot: everything
// else in the trash stayed until a person cleaned it from the Storage view. The conversations' quarantine keeps its own
// rules (store/conversation-units.ts): this sweep runs its prune, never removes anything under it.

export const TRASH_KEEP_MS = QUARANTINE_MS;

export const trashRoot = (historyRoot: string): string => join(historyRoot, "trash");

// `<what>-<ms>`: the moment its writer moved it in, stamped at the end of the name (history.ts, worktrees.ts).
const NAME_STAMP = /-(\d{13})$/u;

// When an entry was set aside, read as late as anything on disk allows, so an entry is never taken for older than it
// is: the stamp its writer put in its name, its ctime (which the rename into the trash set, and which nothing can set
// back) and its mtime. A directory's own mtime alone is the last write inside it before the move, often weeks earlier.
export const trashedAt = (name: string, times: { readonly mtimeMs: number; readonly ctimeMs: number }): number =>
    Math.max(Number(NAME_STAMP.exec(name)?.[1] ?? 0), times.ctimeMs, times.mtimeMs);

// Whether an entry set aside at `at` has been kept its while by `now`; one stamped in the future (a clock stepped back)
// stays.
export const trashExpired = (at: number, now: number, keepMs: number = TRASH_KEEP_MS): boolean => now - at > keepMs;

export interface TrashPass {
    // Entry names removed for good this pass.
    readonly removed: readonly string[];
    // Entries still inside their keeping.
    readonly kept: number;
    // Entries that could not be removed, with why; the next pass tries again.
    readonly failed: readonly { readonly name: string; readonly error: string }[];
}

// One pass over the trash's entries, the conversations' quarantine left to its own prune.
export const sweepTrash = async (historyRoot: string, now: number): Promise<TrashPass> => {
    const root = trashRoot(historyRoot);
    const names = (await readdir(root).catch(undefinedIfMissing)) ?? [];
    const removed: string[] = [];
    const failed: { name: string; error: string }[] = [];
    let kept = 0;
    for (const name of names) {
        const path = join(root, name);
        if (path === quarantineRoot(historyRoot)) {
            continue;
        }
        try {
            // lstat: a link set aside is removed as the link, never followed to what it names.
            const info = await lstat(path).catch(undefinedIfMissing);
            if (info === undefined) {
                continue;
            }
            if (!trashExpired(trashedAt(name, info), now)) {
                kept += 1;
                continue;
            }
            await rm(path, { recursive: true, force: true });
            removed.push(name);
        } catch (error) {
            failed.push({ name, error: errorMessage(error) });
        }
    }
    return { removed, kept, failed };
};

export interface TrashSweepDeps {
    readonly historyRoot: string;
    // services.conversationUnits: the quarantine's own prune, under its own holds.
    readonly units: Pick<ConversationUnits, "prune">;
    // services.transcripts: a pruned directory took records with it, and with them the only names some blobs had.
    readonly transcripts: { readonly sweep: (gone: ReadonlySet<string>) => Promise<void> };
    readonly logger: Pick<Logger, "info" | "warn" | "debug">;
    readonly now?: () => number;
}

// Hourly; root-scoped like the boot's own sweeps (a guest sharing the history root empties nothing).
export const trashSweepChore = (deps: TrashSweepDeps): Chore => ({
    name: "trash-sweep",
    everyMs: HOUR_MS,
    run: async () => {
        const now = (deps.now ?? Date.now)();
        const pass = await sweepTrash(deps.historyRoot, now);
        if (pass.removed.length > 0) {
            deps.logger.info(
                { count: pass.removed.length, kept: pass.kept, keptDays: TRASH_KEEP_MS / DAY_MS },
                "trash: removed entries kept past their while",
            );
        }
        if (pass.failed.length > 0) {
            deps.logger.warn({ count: pass.failed.length, first: pass.failed[0] }, "trash: some entries past their while could not be removed");
        }
        const conversations = await deps.units.prune(now);
        if (conversations.held !== undefined) {
            // The boot's sweep says so once; an hourly line would only repeat it.
            deps.logger.debug({ held: conversations.held }, "trash: the conversations' quarantine is held, nothing removed from it");
            return;
        }
        if (conversations.pruned.length > 0) {
            deps.logger.info({ count: conversations.pruned.length }, "conversations: removed directories set aside past their keeping");
            await deps.transcripts.sweep(new Set());
        }
    },
});
