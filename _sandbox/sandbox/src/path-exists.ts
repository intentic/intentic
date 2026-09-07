/* IS THERE ANYTHING AT THIS PATH, asked once for the whole daemon.
 *
 * Twelve modules carried their own copy of this — the land, the worktrees, the git routes, the engine
 * descriptors, the history, the workspace setup — in three spellings that mean the same thing: `try/await
 * access/catch`, `.then(…, …)`, and `.then().catch()`. Three spellings is how a predicate this small earns a
 * home: nothing about it is a per-caller decision, so a caller writing one is writing the same line again.
 *
 * `access` rather than `stat`, because the question is existence and not shape: a broken symlink, a directory
 * and a file are all "something is there", and a caller that needs to tell them apart wants `stat` and knows it.
 * A dangling permission on a parent reads as absent, which is the honest answer to "can this process reach it". */
import { access } from "node:fs/promises";

export const pathExists = async (path: string): Promise<boolean> =>
    access(path).then(
        () => true,
        () => false,
    );
