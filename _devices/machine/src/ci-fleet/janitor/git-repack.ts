import { join } from "node:path";
import { readTextIfExists } from "@intentic/base/fs";
import { bytesOf, gb, isDir, namesIn } from "./janitor-fs.js";
import { type JanitorRun, runnerBusy } from "./janitor-run.js";

/* A RUNNER'S CHECKOUTS, REPACKED. actions/checkout sets gc.auto=0 and every shallow fetch adds a pack, so nothing else
   ever repacks: omen's worker checkouts held 520-540 packs and 3-7 GB of .git each on 2026-11-17, and 570 MB each after
   `git gc --prune=now` (about 20 s). The runner's service is stopped for the repack, so no job's fetch can race the
   prune; GitHub hands a job queued meanwhile to another runner. Git runs as the owner of .git: some are root's (a job
   container's). */

// A repack of a few GB takes tens of seconds; a stuck one must not hold the runner down for the rest of the day.
const GC_MS = 30 * 60_000;
const UNIT_MS = 90_000;

// The checkouts actions/checkout makes: <work>/<repo>/<repo>/.git, as the script's `"$work"/*/*/.git` globbed them.
const checkouts = async (work: string): Promise<string[]> => {
    const found: string[] = [];
    for (const outer of (await namesIn(work)).filter((name) => !name.startsWith("."))) {
        for (const inner of (await namesIn(join(work, outer))).filter((name) => !name.startsWith("."))) {
            found.push(join(work, outer, inner, ".git"));
        }
    }
    return found;
};

const packCount = async (gitdir: string): Promise<number> => (await namesIn(join(gitdir, "objects", "pack"))).filter((name) => name.endsWith(".pack")).length;

// `runuser -u <owner> -- git -c safe.directory=* <config> -C <repo> <command>`: a checkout a job container made is root's.
const gitAs = (owner: string, repo: string, config: readonly string[], command: readonly string[]): string[] => ["-u", owner, "--", "git", "-c", "safe.directory=*", ...config, "-C", repo, ...command];

// The repack itself, the unit stopped around it: gc, then a connectivity check, and the unit started again whatever they said.
const repack = async (run: JanitorRun, unit: string, gitdir: string, packs: number, size: number): Promise<void> => {
    const { sys } = run.context;
    const repo = gitdir.slice(0, -"/.git".length);
    if ((await sys.run("systemctl", ["stop", unit], { timeoutMs: UNIT_MS })).status !== 0) {
        return;
    }
    const owner = (await sys.run("stat", ["-c", "%U", gitdir], { timeoutMs: 10_000 })).stdout.trim();
    const gc = await sys.run("runuser", gitAs(owner, repo, ["-c", "gc.auto=0"], ["gc", "--prune=now", "--quiet"]), { timeoutMs: GC_MS });
    let rc = String(gc.status ?? "killed");
    const fsck = await sys.run("runuser", gitAs(owner, repo, [], ["fsck", "--connectivity-only", "--no-progress"]), { timeoutMs: GC_MS });
    if (fsck.status !== 0) {
        rc = `${rc}, fsck FAILED`;
    }
    if ((await sys.run("systemctl", ["start", unit], { timeoutMs: UNIT_MS })).status !== 0) {
        run.record.say(`could not start ${unit} again`);
    }
    const after = await bytesOf(gitdir);
    if (size > after) {
        run.record.freedBytes += size - after;
    }
    run.record.say(`repacked ${repo}: ${packs} packs, ${gb(size)} -> ${gb(after)} GB of .git (gc rc ${rc})`);
};

/** Each checkout of one idle runner holding more than `gitPacksMax` packs, repacked with the runner's unit stopped. */
export const repackCheckouts = async (run: JanitorRun, dir: string, work: string): Promise<void> => {
    const unit = (await readTextIfExists(join(dir, ".service")))?.trim() ?? "";
    if (unit === "") {
        return;
    }
    for (const gitdir of await checkouts(work)) {
        // one checkout at a time: each stops the runner's unit for its repack
        if (!(await isDir(join(gitdir, "objects", "pack")))) {
            continue;
        }
        const packs = await packCount(gitdir);
        if (packs <= run.config.gitPacksMax) {
            continue;
        }
        if (await runnerBusy(run, dir)) {
            break;
        }
        const size = await bytesOf(gitdir);
        if (run.record.dryRun) {
            run.record.say(`would repack ${gitdir.slice(0, -"/.git".length)} (${packs} packs, ${gb(size)} GB of .git)`);
            continue;
        }
        await repack(run, unit, gitdir, packs, size);
    }
};
