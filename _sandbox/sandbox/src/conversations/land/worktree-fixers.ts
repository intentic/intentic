import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { errorMessage } from "@intentic/base/errors";
import type { Logger } from "pino";
import { z } from "zod";

// What a machine decides about a turn's change (formatting, a ratcheted baseline it beat, the contract lock and stored
// shapes it moved), written in the conversation's own worktree before its land, so it rides the land that caused it
// instead of sitting uncommitted on the main tree. The fixers are the repository's own (`fixers.mjs`, scoped to the
// change and idempotent); a repository that ships none gets nothing here. The check after the land runs the same
// fixers on the main tree as the backstop (verify.mjs). Never fails a land: a fixer that cannot run leaves the change as
// the turn wrote it.

export const WORKTREE_FIXERS = "_tools/scripts/verify/fixers.mjs";

// A contract emit and a stored-shapes freeze run in well under a minute; past three a fixer is stuck, not slow.
const FIXERS_TIMEOUT_MS = 180_000;

// The one line fixers.mjs prints: the fixers that ran and the repo-relative paths whose content they moved.
const FixersOutputSchema = z.object({ ran: z.array(z.string()), wrote: z.array(z.string()) });

export interface FixersRun {
    readonly repo: string;
    readonly ran: readonly string[];
    readonly wrote: readonly string[];
}

// One repository of the turn's span: its worktree, and the commit it stood at before this turn.
export interface FixersRepo {
    readonly repo: string;
    readonly from: string;
    readonly dir: string;
}

// Runs the repository's fixers in `dir` on what changed since `from`, answering the line they printed.
export type FixersRunner = (dir: string, from: string) => Promise<string>;

const defaultRunner: FixersRunner = async (dir, from) => {
    const { stdout } = await promisify(execFile)("node", [WORKTREE_FIXERS, "--worktree", dir, "--since", from], {
        cwd: dir,
        timeout: FIXERS_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
};

/** Runs each repository's own fixers in its worktree, on what the turn changed; answers what each wrote. Never throws. */
export const runWorktreeFixers = async (
    deps: { readonly logger: Logger },
    conversationId: string,
    span: readonly FixersRepo[],
    run: FixersRunner = defaultRunner,
): Promise<readonly FixersRun[]> => {
    const runs: FixersRun[] = [];
    for (const { repo, from, dir } of span) {
        if (from === "" || !existsSync(join(dir, WORKTREE_FIXERS))) {
            continue;
        }
        try {
            const printed = FixersOutputSchema.parse(JSON.parse((await run(dir, from)).trim().split("\n").at(-1) ?? ""));
            runs.push({ repo, ...printed });
            if (printed.wrote.length > 0) {
                deps.logger.info({ conversationId, repo, ran: printed.ran, wrote: printed.wrote }, "land: the repository's fixers wrote into the worktree before its land");
            }
        } catch (error) {
            deps.logger.warn({ conversationId, repo, reason: errorMessage(error) }, "land: the repository's fixers could not run, the change lands as the turn wrote it");
        }
    }
    return runs;
};
