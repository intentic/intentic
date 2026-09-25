import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import type { Services } from "../../composition.js";
import { mirroredDirs } from "../worktrees/isolation.js";
import type { LandSuspect } from "./land-fix.js";

// Telling several suspect lands apart without a model: each suspect's own landed commit is checked out on its own, with
// the main tree's dependencies mirrored in the way an agent's worktree gets them, and only the failing units are re-run
// there by the command the check itself named (its report's `rerun`). A suspect whose own tree reproduces a failure is
// the one it came with. Cheap by construction: a handful of test files per suspect, never the suite, one at a time.
// A tree where the command cannot say (it crashed, timed out, or had nothing it could re-run alone) makes the whole
// answer unknown rather than a guess, and blame falls back to whatever the paths said.

// Past this many suspects the re-runs cost more than the fix-up that would tell them apart.
export const BISECT_MAX_SUSPECTS = 4;
// One suspect's re-run; a handful of test files, so minutes are already a sign something else is wrong.
const RERUN_TIMEOUT_MS = 10 * 60_000;
// The rerun command's own contract: 1 is "reproduced", 0 is "none did", anything else is "cannot say".
const REPRODUCED = 1;
const CLEAN = 0;

type Verdict = "reproduced" | "clean" | "unknown";

// Runs `command` in `cwd` with `env` added, answering its exit code, or undefined when it died or ran out of time.
export type RerunRunner = (command: string, cwd: string, env: Readonly<Record<string, string>>, timeoutMs: number) => Promise<number | undefined>;

const runRerun: RerunRunner = (command, cwd, env, timeoutMs) =>
    new Promise((resolve) => {
        const child = spawn("bash", ["-c", command], { cwd, env: { ...process.env, ...env }, stdio: "ignore", detached: true });
        const timer = setTimeout(() => {
            // The whole group: the command is a test runner with workers of its own. Gone already is fine; the exit
            // below answers either way.
            try {
                if (child.pid !== undefined) {
                    process.kill(-child.pid, "SIGKILL");
                }
            } catch {
                // silent-catch: the group ended between the deadline and the kill, which is what the kill wanted.
            }
        }, timeoutMs);
        timer.unref();
        child.once("error", () => {
            clearTimeout(timer);
            resolve(undefined);
        });
        child.once("exit", (code) => {
            clearTimeout(timer);
            resolve(code ?? undefined);
        });
    });

export type BisectDeps = Pick<Services, "agentWorktrees" | "logger">;

export interface BisectAsk {
    readonly project: string;
    readonly suspects: readonly LandSuspect[];
    // The failures to re-run, as the check's report named them.
    readonly failures: readonly string[];
    readonly rerun: string;
}

// One suspect's own tree, asked whether it reproduces the failures.
const verdictAt = async (deps: BisectDeps, ask: BisectAsk, suspect: LandSuspect, git: GitRunner, run: RerunRunner): Promise<Verdict> => {
    const { tip } = suspect;
    if (tip === undefined) {
        return "unknown";
    }
    const repo = ask.project === "" ? "root" : ask.project;
    const main = deps.agentWorktrees.mainDir(repo);
    const scratch = await mkdtemp(join(tmpdir(), "land-bisect-"));
    const tree = join(scratch, "tree");
    let added = false;
    try {
        await deps.agentWorktrees.withRepoLock(repo, () => git(main, ["worktree", "add", "--detach", tree, tip]));
        added = true;
        // Symlinks only: the re-run reads the main tree's installed dependencies and writes nothing a land could carry.
        for (const mirror of await mirroredDirs(main, tree, { intoNestedRepos: false })) {
            await mkdir(dirname(join(tree, mirror)), { recursive: true });
            await symlink(join(main, mirror), join(tree, mirror));
        }
        const units = join(scratch, "units.json");
        await writeFile(units, JSON.stringify(ask.failures));
        const code = await run(ask.rerun, tree, { INTENTIC_RERUN_UNITS: units }, RERUN_TIMEOUT_MS);
        return code === REPRODUCED ? "reproduced" : code === CLEAN ? "clean" : "unknown";
    } catch (error) {
        deps.logger.warn({ err: error, conversationId: suspect.land.agentId, project: ask.project }, "land bisect: a suspect's tree could not be asked");
        return "unknown";
    } finally {
        if (added) {
            await deps.agentWorktrees
                .withRepoLock(repo, () => git(main, ["worktree", "remove", "--force", tree]))
                .catch((error: unknown) => deps.logger.warn({ err: error, tree }, "land bisect: the scratch worktree could not be removed"));
        }
        await rm(scratch, { recursive: true, force: true });
    }
};

// The suspects whose own landed tree reproduces the failures, or undefined when the answer is unknown: too few or too
// many suspects to be worth it, any tree that could not say, or none that reproduced (the break needs them together).
export const bisectSuspects = async (
    deps: BisectDeps,
    ask: BisectAsk,
    git: GitRunner = defaultGit,
    run: RerunRunner = runRerun,
): Promise<LandSuspect[] | undefined> => {
    if (ask.suspects.length < 2 || ask.suspects.length > BISECT_MAX_SUSPECTS) {
        return undefined;
    }
    const verdicts: Verdict[] = [];
    for (const suspect of ask.suspects) {
        // One at a time: each is a test run, and the machine is shared with the conversations still working.
        verdicts.push(await verdictAt(deps, ask, suspect, git, run));
    }
    if (verdicts.includes("unknown")) {
        return undefined;
    }
    const reproduced = ask.suspects.filter((_, index) => verdicts[index] === "reproduced");
    return reproduced.length === 0 ? undefined : reproduced;
};
