import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import type { GitRunner } from "@intentic/base/git";
import type { Logger } from "pino";
import { z } from "zod";
import { materializedPaths } from "../../git/changes/changes-porcelain.js";
import { runCheck } from "../../workload/run-check.js";

// DERIVED FILES ARE WRITTEN WHERE THE WORK LANDS. A repository marks each file it derives from its own sources
// `merge=derived` in its .gitattributes (intentic: the contract lock, the stored shapes, the daemon's generated
// indexes). Such a file is a function of the whole tree, so no branch's copy of it is right for the tree it lands in:
// a land never carries one (UNDERIVED ends every delta it reads), and once its patch is written the repository's own
// fixers write them again THERE, from what landed. Two conversations that both moved the contract land one after the
// other with no conflict, and the lock in the tree they land in is the one its sources make. A rebase keeps the side it
// lands on, through the merge driver of that name the repository configures for itself.
//
// Never in the conversation's worktree, where the fixers ran until 2026-10-20: the daemon reads a worktree without the
// dependencies a turn's namespace mounts over it, so every fixer that imports anything failed there, silently (from
// 10-09 to 10-20 the lock, the indexes and the shapes were rewritten by none of 105 runs that wrote something). The
// tree a land writes into is the owner's, which has them. Never fails a land: what a fixer could not write stays as the
// tree had it, and CI's own checks say so.

export const REPO_FIXERS = "_tools/scripts/verify/fixers.mjs";

// The pathspec that ends every delta a land reads: the whole tree but what the repository marks derived.
export const UNDERIVED: readonly string[] = ["--", ":/", ":(exclude,attr:merge=derived)"];
// The same mark asked the other way: only what the repository derives.
const DERIVED: readonly string[] = ["--", ":(attr:merge=derived)"];

// A generator that builds the contract and freezes every stored shape runs in well under a minute; past three, stuck.
const FIXERS_TIMEOUT_MS = 180_000;

// The one line fixers.mjs prints: the fixers that ran and the repo-relative paths whose content they moved.
const FixersOutputSchema = z.object({ ran: z.array(z.string()), wrote: z.array(z.string()) });

// What one repository's fixers did in the tree a land wrote into; `failed` when they could not run at all.
export type Rederived =
    | { readonly repo: string; readonly ran: readonly string[]; readonly wrote: readonly string[] }
    | { readonly repo: string; readonly failed: string };

// Runs the repository's fixers in `dir` over the paths listed in `pathsFile`, answering what they printed.
export type FixersRunner = (dir: string, pathsFile: string) => Promise<string>;

const defaultRunner: FixersRunner = async (dir, pathsFile) => {
    const ran = await runCheck({
        argv: [process.execPath, REPO_FIXERS, "--worktree", dir, "--paths-file", pathsFile],
        cwd: dir,
        timeoutMs: FIXERS_TIMEOUT_MS,
        workload: { class: "toolchain" },
        kind: "fixers",
        captureBytes: 64 * 1024,
        keep: "tail",
    });
    if (ran.exitCode !== 0) {
        throw new Error(ran.spawnError ?? ran.ended ?? (ran.stderr.trim() || `exit ${String(ran.exitCode)}`));
    }
    return ran.stdout;
};

/**
 * Writes again, in `main`, whatever the repository derives from the paths a land just wrote there (`from`..`tip`, the
 * delta as the branch made it, derived paths included, since a fixer is chosen by its inputs). Undefined where the
 * repository ships no fixers; never throws.
 */
const rederive = async (
    main: string,
    repo: string,
    range: { readonly from: string; readonly tip: string },
    git: GitRunner,
    run: FixersRunner = defaultRunner,
): Promise<Rederived | undefined> => {
    if (!existsSync(join(main, REPO_FIXERS))) {
        return undefined;
    }
    const scratch = await mkdtemp(join(tmpdir(), "intentic-rederive-"));
    try {
        const landed = materializedPaths((await git(main, ["diff", "--name-only", "--no-renames", "-z", range.from, range.tip])).stdout);
        const pathsFile = join(scratch, "paths");
        await writeFile(pathsFile, landed.join("\n"));
        const printed = FixersOutputSchema.parse(JSON.parse((await run(main, pathsFile)).trim().split("\n").at(-1) ?? ""));
        return { repo, ...printed };
    } catch (error) {
        return { repo, failed: errorMessage(error) };
    } finally {
        await rm(scratch, { recursive: true, force: true });
    }
};

/** The derived paths `dir`'s working tree holds differently from its HEAD: what the next commit of landed work there carries. */
export const derivedChanges = async (dir: string, git: GitRunner): Promise<readonly string[]> =>
    materializedPaths((await git(dir, ["diff", "--name-only", "--no-renames", "-z", "HEAD", ...DERIVED])).stdout);

/**
 * `rederive` for each tree a land just wrote, in turn; undefined when no repository ships fixers. A three-way write left
 * markers for a person, so nothing is derived from it until they are resolved.
 */
export const rederiveAll = async (
    writes: readonly { readonly kind: string; readonly main: string; readonly repo: string; readonly from: string; readonly tip: string }[],
    git: GitRunner,
): Promise<Rederived[] | undefined> => {
    const derived: Rederived[] = [];
    for (const write of writes.filter(({ kind }) => kind !== "merge")) {
        const done = await rederive(write.main, write.repo, write, git);
        if (done !== undefined) {
            derived.push(done);
        }
    }
    return derived.length > 0 ? derived : undefined;
};

/** Said by every door a land goes through: pnpm's reason for a lockfile it could not write, and what the repository's
 *  fixers derived again where the work landed, or why they could not. */
export const reportLandRepairs = (
    logger: Pick<Logger, "info" | "warn">,
    id: string,
    outcome: { readonly lockfileFailures?: readonly { readonly repo: string; readonly reason: string }[]; readonly derived?: readonly Rederived[] },
): void => {
    for (const { repo, reason } of outcome.lockfileFailures ?? []) {
        logger.warn({ id, repo, reason }, "agents: lockfile could not be regenerated for a changed manifest");
    }
    for (const done of outcome.derived ?? []) {
        if ("failed" in done) {
            logger.warn({ id, repo: done.repo, reason: done.failed }, "land: the repository's fixers could not run where the work landed");
        } else if (done.wrote.length > 0) {
            logger.info({ id, ...done }, "land: the repository's fixers derived files again where the work landed");
        }
    }
};
