import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sleep } from "@intentic/base/async";
import { errorMessage } from "@intentic/base/errors";
import { defaultGit, type GitRunner } from "@intentic/base/git";
import type { Logger } from "pino";
import { z } from "zod";
import { materializedPaths } from "../../git/changes/changes-porcelain.js";
import { runCheck } from "../../workload/run-check.js";
import type { AgentWorktrees } from "../worktrees/worktrees.js";

// DERIVED FILES ARE WRITTEN AGAIN WHERE THE WORK LANDED, AFTER THE LAND. A repository marks each file it derives from
// its own sources `merge=derived` in its .gitattributes (intentic: the contract lock, the stored shapes, the daemon's
// generated indexes). Such a file is a function of the whole tree, so no branch's copy of it is right for the tree it
// lands in: a land never carries one (UNDERIVED ends every delta it reads), and once its patch is in, the repository's
// own derived writers write them again THERE, from what landed. Two conversations that both moved the contract land one
// after the other with no conflict, and the lock in the tree they land in is the one its sources make. A rebase keeps
// the side it lands on, through the merge driver of that name the repository configures for itself.
//
// NEVER PART OF THE LAND ITSELF (2026-10-21). A land is a git operation: its patch written and read back. From 10-20 the
// whole of fixers.mjs ran inside it, under the repo locks and the land lease: rustfmt, every ratchet's `--tighten` and
// the derived writers, 36 s on an idle machine (dead-code's tighten alone 15 s), all of it with the card on "Landing…"
// and the review's rescan parked, and every later land into the repo queued behind it. Now the land only names what it
// wrote (LandOutcome.rederive) and the door it went through hands that here once the lease is released: the derived
// writers alone (`--only derived`, about 2 s), one run per tree at a time, a burst of lands folded into one run, each
// run under the repo lock so no land writes the tree while they do. rustfmt and tightening are a person's or CI's.
//
// Never in the conversation's worktree, where the fixers ran until 2026-10-20: the daemon reads a worktree without the
// dependencies a turn's namespace mounts over it, so every fixer that imports anything failed there, silently. The tree
// a land writes into is the owner's, which has them. Never fails anything: what a writer could not write stays as the
// tree had it, and CI's own checks say so.

export const REPO_FIXERS = "_tools/scripts/verify/fixers.mjs";

// The pathspec that ends every delta a land reads: the whole tree but what the repository marks derived.
export const UNDERIVED: readonly string[] = ["--", ":/", ":(exclude,attr:merge=derived)"];
// The same mark asked the other way: only what the repository derives.
const DERIVED: readonly string[] = ["--", ":(attr:merge=derived)"];

// The derived writers (the contract built from source, every stored shape frozen) run in seconds; past three minutes, stuck.
const FIXERS_TIMEOUT_MS = 180_000;

// The one line fixers.mjs prints: the fixers that ran and the repo-relative paths whose content they moved.
const FixersOutputSchema = z.object({ ran: z.array(z.string()), wrote: z.array(z.string()) });

// What one repository's derived writers did in the tree a land wrote into; `failed` when they could not run at all.
export type Rederived =
    | { readonly repo: string; readonly ran: readonly string[]; readonly wrote: readonly string[] }
    | { readonly repo: string; readonly failed: string };

// One repo a land wrote into the main tree: the checkout, and the delta as the branch made it, derived paths included,
// since a writer is chosen by its inputs.
export interface RederiveWrite {
    readonly repo: string;
    readonly main: string;
    readonly from: string;
    readonly tip: string;
}

// What the derived writers are handed for a land into the main tree: each patch it wrote, never a three-way write, which
// left markers for a person. Undefined when there is none. A child's land into its parent's checkout hands nothing: the
// parent's own land reaches the main tree with the child's work in its delta.
export const rederiveWrites = (writes: readonly ((RederiveWrite & { readonly kind: string }) | undefined)[]): RederiveWrite[] | undefined => {
    const handed = writes.flatMap((write) =>
        write === undefined || write.kind === "merge" ? [] : [{ repo: write.repo, main: write.main, from: write.from, tip: write.tip }],
    );
    return handed.length > 0 ? handed : undefined;
};

// Runs the repository's derived writers in `dir` over the paths listed in `pathsFile`, answering what they printed.
export type FixersRunner = (dir: string, pathsFile: string) => Promise<string>;

const defaultRunner: FixersRunner = async (dir, pathsFile) => {
    const ran = await runCheck({
        argv: [process.execPath, REPO_FIXERS, "--worktree", dir, "--paths-file", pathsFile, "--only", "derived"],
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

// Runs the derived writers in `main` over `paths`. Undefined where the repository ships no fixers; never throws.
const rederive = async (main: string, repo: string, paths: readonly string[], run: FixersRunner): Promise<Rederived | undefined> => {
    if (!existsSync(join(main, REPO_FIXERS))) {
        return undefined;
    }
    const scratch = await mkdtemp(join(tmpdir(), "intentic-rederive-"));
    try {
        const pathsFile = join(scratch, "paths");
        await writeFile(pathsFile, paths.join("\n"));
        const printed = FixersOutputSchema.parse(JSON.parse((await run(main, pathsFile)).trim().split("\n").at(-1) ?? ""));
        return { repo, ...printed };
    } catch (error) {
        return { repo, failed: errorMessage(error) };
    } finally {
        await rm(scratch, { recursive: true, force: true });
    }
};

export interface RederiveDeps {
    readonly agentWorktrees: Pick<AgentWorktrees, "withRepoLock">;
    readonly logger: Pick<Logger, "info" | "warn">;
}

// Per main checkout: the paths lands wrote that no run has taken yet, the run draining them while one is going, and
// every hand-off not yet through a run (what rederiveSettled waits on).
interface TreeQueue {
    readonly repo: string;
    readonly pending: Set<string>;
    readonly ids: Set<string>;
    readonly handed: Set<Promise<void>>;
    draining: Promise<void> | undefined;
}
const queues = new Map<string, TreeQueue>();

const queueOf = (main: string, repo: string): TreeQueue => {
    const known = queues.get(main);
    if (known !== undefined) {
        return known;
    }
    const queue: TreeQueue = { repo, pending: new Set(), ids: new Set(), handed: new Set(), draining: undefined };
    queues.set(main, queue);
    return queue;
};

const report = (logger: RederiveDeps["logger"], ids: readonly string[], done: Rederived): void => {
    if ("failed" in done) {
        logger.warn({ ids, repo: done.repo, reason: done.failed }, "land: the repository's fixers could not run where the work landed");
    } else if (done.wrote.length > 0) {
        logger.info({ ids, ...done }, "land: the repository's fixers derived files again where the work landed");
    }
};

// One run under the repo lock, so no land writes the tree while the writers read and write it.
const runLocked = async (deps: RederiveDeps, main: string, repo: string, paths: readonly string[], run: FixersRunner): Promise<Rederived | undefined> => {
    try {
        return await deps.agentWorktrees.withRepoLock(repo, () => rederive(main, repo, paths, run));
    } catch (error) {
        return { repo, failed: errorMessage(error) };
    }
};

// Takes whatever is pending in one go, so every land that came while a run was going is folded into the next one. The
// draining mark is cleared with no await after the last look at `pending`, so a path added later always starts a run.
const drain = async (deps: RederiveDeps, main: string, queue: TreeQueue, run: FixersRunner): Promise<void> => {
    try {
        while (queue.pending.size > 0) {
            const paths = [...queue.pending].toSorted();
            const ids = [...queue.ids];
            queue.pending.clear();
            queue.ids.clear();
            const done = await runLocked(deps, main, queue.repo, paths, run);
            if (done !== undefined) {
                report(deps.logger, ids, done);
            }
        }
    } finally {
        queue.draining = undefined;
    }
};

// The paths `from`..`tip` changed, read in `main`; none, said, where git could not read them.
const changedPaths = async (deps: RederiveDeps, id: string, write: RederiveWrite, git: GitRunner): Promise<readonly string[]> => {
    try {
        return materializedPaths((await git(write.main, ["diff", "--name-only", "--no-renames", "-z", write.from, write.tip])).stdout);
    } catch (error) {
        deps.logger.warn({ id, repo: write.repo, err: error }, "land: could not read what the work changed, nothing derived again for it");
        return [];
    }
};

// Queues one write's paths and makes sure a run is going; resolves once the run that took them has ended.
const handOver = async (deps: RederiveDeps, id: string, write: RederiveWrite, queue: TreeQueue, git: GitRunner, run: FixersRunner): Promise<void> => {
    const paths = await changedPaths(deps, id, write, git);
    if (paths.length === 0) {
        return;
    }
    for (const path of paths) {
        queue.pending.add(path);
    }
    queue.ids.add(id);
    queue.draining ??= drain(deps, write.main, queue, run);
    await queue.draining;
};

/**
 * Hands what land `id` wrote into the main tree to that tree's derived writers, in the background: returns at once, and
 * never throws. A three-way write left markers for a person, so it is not handed here at all (land.ts).
 */
export const scheduleRederive = (
    deps: RederiveDeps,
    id: string,
    writes: readonly RederiveWrite[],
    git: GitRunner = defaultGit,
    run: FixersRunner = defaultRunner,
): void => {
    for (const write of writes) {
        if (!existsSync(join(write.main, REPO_FIXERS))) {
            continue;
        }
        const queue = queueOf(write.main, write.repo);
        const handed = handOver(deps, id, write, queue, git, run);
        queue.handed.add(handed);
        void handed.finally(() => queue.handed.delete(handed));
    }
};

/**
 * Resolves once no derived writer is running or queued for any of `mains`, or after `capMs`; never rejects. What a
 * version commit waits on, so the derived files ride the commit of the work they were derived from.
 */
export const rederiveSettled = async (mains: readonly string[], capMs: number = FIXERS_TIMEOUT_MS): Promise<void> => {
    const going = mains.flatMap((main) => [...(queues.get(main)?.handed ?? [])]);
    if (going.length === 0) {
        return;
    }
    const cap = new AbortController();
    await Promise.race([Promise.allSettled(going), sleep(capMs, { signal: cap.signal, unref: true })]);
    cap.abort();
};

// Stage/commit only after the background writers, without holding the lock those writers need. A land may queue a
// writer while this caller waits for the lock: check again inside it, release it, and wait for that hand-off too.
export const withRederivedRepo = async <T>(
    main: string,
    locked: <R>(run: () => Promise<R>) => Promise<R>,
    run: () => Promise<T>,
): Promise<T> => {
    for (;;) {
        await rederiveSettled([main]);
        const result = await locked(async () => {
            if ((queues.get(main)?.handed.size ?? 0) > 0) {
                return { ready: false } as const;
            }
            return { ready: true, value: await run() } as const;
        });
        if (result.ready) {
            return result.value;
        }
    }
};

/** The derived paths `dir`'s working tree holds differently from its HEAD: what the next commit of landed work there carries. */
export const derivedChanges = async (dir: string, git: GitRunner): Promise<readonly string[]> =>
    materializedPaths((await git(dir, ["diff", "--name-only", "--no-renames", "-z", "HEAD", ...DERIVED])).stdout);

/** Said by every door a land goes through, once its lease is released: pnpm's reason for a lockfile it could not write;
 *  and the derived files it left out handed to that tree's writers, in the background (scheduleRederive). */
export const afterLand = (
    deps: RederiveDeps,
    id: string,
    outcome: { readonly lockfileFailures?: readonly { readonly repo: string; readonly reason: string }[]; readonly rederive?: readonly RederiveWrite[] },
): void => {
    for (const { repo, reason } of outcome.lockfileFailures ?? []) {
        deps.logger.warn({ id, repo, reason }, "agents: lockfile could not be regenerated for a changed manifest");
    }
    if (outcome.rederive !== undefined && outcome.rederive.length > 0) {
        scheduleRederive(deps, id, outcome.rederive);
    }
};
