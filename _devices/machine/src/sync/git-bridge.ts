import { existsSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { HISTORY_ROOT, STATE_DIR } from "@intentic/constants";
import { GIT_GLOBAL_ARGS } from "@intentic/base/git";
import type { Log } from "@intentic/local-agent";
import { type BridgeHold, type BridgeHoldReason, isProjectPairing, type Pairing, pairingKey, pruneBridgeHolds, setBridgeHold } from "./config.js";
import { runProcess, runWatched } from "./exec.js";
import { sshAlias } from "./ssh.js";

// Moves git state, not worktree files, which file sync owns, from the sandbox's real git dirs to the local clone:
// fetch, then fast-forward. One-way only: local commits or staged work the sandbox lacks freeze the bridge rather
// than being rebased, reset or merged. Steady state costs one ls-remote per repo.
//
// A FETCH THAT CANNOT FINISH MUST NOT RUN AGAIN EVERY PASS (2026-10-18). The fetch used to share the two-minute deadline
// of every other command here and run again on the next pass when it was cut off. A repository whose history did not
// fit in two minutes over the owner's connection (a big one, or one whose history the local clone shares nothing with)
// was killed mid-transfer every time, and every killed fetch left its half-received pack in `.git/objects/pack` as a
// `tmp_pack_*` file git never cleans up by itself: a Windows laptop's drive filled with hundreds of GB of them. A
// fetch now runs for as long as it keeps moving (exec.ts `runWatched`), beside the watcher's pass rather than inside
// it (mirror.ts `startBridge`); one that ends without finishing has the temporary files it left removed, and the repo
// is held (`BridgeHold`, kept on the pairing) for a wait that doubles with each try, which the report shows.

// Keep bridge execution async so shared loopback SSH cannot deadlock.
export interface BridgeExec {
    // Run a command capturing stdout; undefined ⇒ it failed (non-zero exit, spawn error, timeout).
    readonly run: (command: string, args: readonly string[], cwd?: string) => Promise<string | undefined>;
    // The one long command: a `git fetch` (args after `git`), watched rather than given a deadline.
    readonly fetch: (args: readonly string[], cwd: string, signal?: AbortSignal) => Promise<FetchResult>;
    readonly exists: (path: string) => boolean;
}

// How a fetch ended. `stopped` is this agent's own doing (the pairing paused, the watcher went away): nobody's failure,
// so it holds nothing back.
export type FetchOutcome = "fetched" | "stopped" | BridgeHoldReason;

export interface FetchResult {
    readonly outcome: FetchOutcome;
    // What git said, for telling a shallow refusal apart from the rest.
    readonly stderr: string;
}

// A hung tunnel must not wedge one pass for good. Every command but the fetch is small.
const EXEC_TIMEOUT_MS = 120_000;

// The fetch's allowances: three minutes without a word from git is a stall (with `--progress` it reports several times
// a second while bytes move, and the quietest stretch, the sandbox counting a huge repo's objects, reports too), and
// three hours is past what any connection should spend on one repo's history in one go.
const FETCH_QUIET_MS = 3 * 60_000;
const FETCH_CEILING_MS = 3 * 60 * 60_000;

// Every git here runs in the user's own repo, perhaps while their editor or terminal runs git in it too: the shared
// GIT_GLOBAL_ARGS keep a read off index.lock (`--no-optional-locks`, which leaves the locks a write takes alone) and read
// modes the sandbox's way. Through runProcess rather than the base git runner, which has no deadline: a fetch or
// ls-remote over a hung tunnel must end with this pass.
export const realBridgeExec: BridgeExec = {
    run: async (command, args, cwd) => {
        const argv = command === "git" ? [...GIT_GLOBAL_ARGS, ...args] : args;
        const result = await runProcess(command, argv, { cwd, timeoutMs: EXEC_TIMEOUT_MS });
        return result.status === 0 ? result.stdout : undefined;
    },
    fetch: async (args, cwd, signal) => {
        const result = await runWatched("git", [...GIT_GLOBAL_ARGS, ...args], { cwd, quietMs: FETCH_QUIET_MS, ceilingMs: FETCH_CEILING_MS, signal });
        const outcome: FetchOutcome =
            result.ending === "stalled"
                ? "stalled"
                : result.ending === "ceiling"
                  ? "too-long"
                  : result.ending === "stopped"
                    ? "stopped"
                    : result.status === 0
                      ? "fetched"
                      : "failed";
        return { outcome, stderr: result.stderr };
    },
    exists: existsSync,
};

// HOW LONG A HELD REPO WAITS. The first wait after a stall or a plain failure is ten minutes and each later one twice
// the last, up to half a day: a sandbox that was briefly unreachable is followed again soon, and a fetch that will
// never fit costs a couple of tries a day instead of one a pass. A fetch still moving at its ceiling starts at half a
// day, since the next one will be as long; a shallow refusal at a day, since nothing on this side changes it.
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WAITS = {
    stalled: { first: 10 * MINUTE, most: 12 * HOUR },
    failed: { first: 10 * MINUTE, most: 12 * HOUR },
    "too-long": { first: 12 * HOUR, most: 2 * DAY },
    shallow: { first: DAY, most: 7 * DAY },
} as const satisfies Record<BridgeHoldReason, { readonly first: number; readonly most: number }>;

// The hold a fetch that did not finish leaves, from the one before it (if any).
export const nextHold = (repo: string, previous: BridgeHold | undefined, reason: BridgeHoldReason, now: number): BridgeHold => {
    const failures = (previous?.failures ?? 0) + 1;
    const { first, most } = WAITS[reason];
    const wait = Math.min(first * 2 ** Math.min(failures - 1, 20), most);
    return { repo, reason, failures, since: previous?.since ?? now, retryAt: now + wait };
};

// What a failed fetch's words make of it: git refusing refs that would need this clone to become shallow is its own
// reason, the one a person has to act on in the sandbox.
// allow(dependency-text): git prints its refusal ("rejected <ref> because shallow roots are not allowed to be updated",
// fetch-pack/fetch) as words only, with no exit code of its own; an unmatched wording reads as `failed`, which only waits
// the shorter time before trying again.
export const failureReason = (stderr: string): BridgeHoldReason => (/shallow/i.test(stderr) ? "shallow" : "failed");

// Where the bridge reads and keeps its holds: the pairing's record (`pairingMemory`), or a test's map.
export interface BridgeMemory {
    readonly held: (repo: string) => BridgeHold | undefined;
    readonly record: (repo: string, hold: BridgeHold | undefined) => Promise<void>;
}

// Holds nothing and keeps nothing: every fetch is tried, as before holds existed.
const forgetfulMemory: BridgeMemory = { held: () => undefined, record: async () => {} };

// The pairing's own holds, read once for this run and written through as they change.
const pairingMemory = (pairing: Pairing): BridgeMemory => {
    const holds = new Map((pairing.bridgeHolds ?? []).map((hold) => [hold.repo, hold]));
    return {
        held: (repo) => holds.get(repo),
        record: async (repo, hold) => {
            if (hold === undefined && !holds.has(repo)) {
                return;
            }
            if (hold === undefined) {
                holds.delete(repo);
            } else {
                holds.set(repo, hold);
            }
            await setBridgeHold(pairingKey(pairing), repo, hold);
        },
    };
};

// WHAT A FETCH THAT DID NOT FINISH LEFT BEHIND. Git receives a pack into `objects/pack/tmp_pack_*` (with `tmp_idx_*`
// and `tmp_rev_*` beside it) and renames it only once it is whole; killed, it leaves the temporary files, and nothing but
// a `git gc` two weeks later removes them. Removed here are the temporary files that appeared during the fetch, and any
// older than an hour (an earlier agent's, or a fetch that died with its machine). Never a finished `pack-*`: one that
// appeared during the fetch could as well be the owner's own `git fetch` running in the same clone, and its objects are
// theirs. And never a file still growing, which is some other git's receive in progress: each is measured twice, a
// moment apart, and only what held still goes.
export interface PackTemp {
    readonly name: string;
    readonly size: number;
    readonly modifiedAt: number;
}

export interface PackFs {
    // The `tmp_*` files in a pack folder; none when it cannot be read.
    readonly temps: (packDir: string) => Promise<readonly PackTemp[]>;
    readonly remove: (path: string) => Promise<boolean>;
    readonly settle: () => Promise<void>;
}

export const STALE_TEMP_MS = HOUR;
const SETTLE_MS = 2_000;

const realPackFs: PackFs = {
    temps: async (packDir) => {
        // allow(silent-catch): a pack folder that is missing or unreadable holds nothing this can clear.
        const names = await readdir(packDir).catch((): string[] => []);
        const temps: PackTemp[] = [];
        for (const name of names.filter((entry) => entry.startsWith("tmp_"))) {
            // a handful of files, read one at a time
            // allow(silent-catch): a file gone between the listing and its stat (its git renamed it) is not one to clear.
            const info = await stat(join(packDir, name)).catch(() => undefined);
            if (info?.isFile() === true) {
                temps.push({ name, size: info.size, modifiedAt: info.mtimeMs });
            }
        }
        return temps;
    },
    // allow(silent-catch): a file another git still holds open (Windows refuses the delete) is left for the next sweep.
    remove: async (path) => await rm(path, { force: true }).then(() => true, () => false),
    settle: async () => await sleep(SETTLE_MS),
};

// Which temporary files go: those that appeared since `before` or are older than STALE_TEMP_MS, and held still between
// the two readings.
export const strandedTemps = (
    first: readonly PackTemp[],
    second: readonly PackTemp[],
    before: ReadonlySet<string>,
    now: number,
): PackTemp[] => {
    const again = new Map(second.map((temp) => [temp.name, temp]));
    return first.filter((temp) => {
        const later = again.get(temp.name);
        const still = later !== undefined && later.size === temp.size && later.modifiedAt === temp.modifiedAt;
        return still && (!before.has(temp.name) || now - temp.modifiedAt >= STALE_TEMP_MS);
    });
};

// Clears what `strandedTemps` names, answering the bytes freed.
const clearStranded = async (packs: PackFs, packDir: string, before: ReadonlySet<string>, now: number): Promise<number> => {
    const first = await packs.temps(packDir);
    if (!first.some((temp) => !before.has(temp.name) || now - temp.modifiedAt >= STALE_TEMP_MS)) {
        return 0;
    }
    await packs.settle();
    let freed = 0;
    for (const temp of strandedTemps(first, await packs.temps(packDir), before, now)) {
        // one at a time; a refusal stops only that file
        if (await packs.remove(join(packDir, temp.name))) {
            freed += temp.size;
        }
    }
    return freed;
};

// Pack folders this process has already swept for an earlier agent's leftovers: once each is enough.
const sweptPackDirs = new Set<string>();

const gigabytes = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

const untilWhen = (at: number, now: number): string => {
    const minutes = Math.max(1, Math.round((at - now) / MINUTE));
    return minutes < 120 ? `${minutes} minutes` : `${Math.round(minutes / 60)} hours`;
};

const HOLD_SAID = {
    stalled: "the fetch stopped moving",
    "too-long": `the fetch was still running after ${FETCH_CEILING_MS / HOUR} hours`,
    shallow: "the sandbox's copy is a shallow clone, which this folder's full history cannot take",
    failed: "git refused the fetch",
} as const satisfies Record<BridgeHoldReason, string>;

export interface BridgeOptions {
    readonly memory?: BridgeMemory | undefined;
    readonly packs?: PackFs | undefined;
    readonly signal?: AbortSignal | undefined;
    readonly now?: (() => number) | undefined;
}

// Repo-id shape enforced by workspace/repo-discovery.ts: 1-4 segments, each starting alphanumeric. Re-checked here
// since ids arrive as sandbox directory names; unvalidated, joining under localDir risks a path escape.
const SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const isSafeRepoId = (id: string): boolean => {
    const segments = id.split("/");
    return segments.length <= 4 && segments.every((segment) => SEGMENT.test(segment));
};

// Repo ids are the URI-encoded git-dir names under /history/gits, read over ssh (the daemon consults the same
// listing). Undefined means the sandbox was unreachable; retry next pass.
export const listSandboxRepos = async (exec: BridgeExec, alias: string): Promise<string[] | undefined> => {
    const out = await exec.run("ssh", ["-o", "BatchMode=yes", alias, "ls", `${HISTORY_ROOT}/gits`]);
    if (out === undefined) {
        return undefined;
    }
    return out
        .split("\n")
        .map((line) => decodeURIComponent(line.trim()))
        .filter((id) => id !== "" && id !== "root" && isSafeRepoId(id));
};

// What one fetch needs besides the repo it fetches into.
interface FetchSeams {
    readonly exec: BridgeExec;
    readonly packs: PackFs;
    readonly memory: BridgeMemory;
    readonly now: () => number;
    readonly log: Log;
    readonly signal: AbortSignal | undefined;
}

// The pack folder of a clone, wherever its git dir is (a `.git` file pointing elsewhere included); undefined when git
// cannot say.
const packDirOf = async (exec: BridgeExec, dir: string): Promise<string | undefined> => {
    const out = (await exec.run("git", ["rev-parse", "--git-path", "objects/pack"], dir))?.trim();
    return out === undefined || out === "" ? undefined : resolve(dir, out);
};

// ONE FETCH OF THE SANDBOX'S BRANCH, and everything that follows from how it ended: true when the objects are here.
// A clone the bridge itself started (no commits yet) or one already shallow may take the sandbox's shallow boundary as
// its own (`--update-shallow`); a clone with a full history of its own is never made shallow behind its owner's back, so
// for it a shallow sandbox copy is a hold that says so. Whatever did not finish has its temporary files cleared and the
// repo held; a fetch this agent stopped holds nothing.
const fetchFromSandbox = async (
    seams: FetchSeams,
    dir: string,
    repo: string,
    branch: string,
    head: string | undefined,
    hold: BridgeHold | undefined,
): Promise<boolean> => {
    const { exec, packs, memory, now, log } = seams;
    const packDir = await packDirOf(exec, dir);
    if (packDir !== undefined && !sweptPackDirs.has(packDir)) {
        sweptPackDirs.add(packDir);
        // An earlier agent's leftovers first: everything there now counts as before this run, so only the stale goes.
        const freed = await clearStranded(packs, packDir, new Set((await packs.temps(packDir)).map((temp) => temp.name)), now());
        if (freed > 0) {
            log(`  ${repo}: removed ${gigabytes(freed)} of half-received git packs an earlier fetch left behind`);
        }
    }
    const before = new Set(packDir === undefined ? [] : (await packs.temps(packDir)).map((temp) => temp.name));
    const shallowOk = head === undefined || (await exec.run("git", ["rev-parse", "--is-shallow-repository"], dir))?.trim() === "true";
    const refspec = `+refs/heads/${branch}:refs/remotes/sandbox/${branch}`;
    const fetched = await exec.fetch(["fetch", "--progress", ...(shallowOk ? ["--update-shallow"] : []), "sandbox", refspec], dir, seams.signal);
    if (fetched.outcome === "fetched") {
        if (hold !== undefined) {
            log(`  ${repo}: fetched from the sandbox again, after ${hold.failures === 1 ? "one try" : `${hold.failures} tries`} that did not finish`);
        }
        await memory.record(repo, undefined);
        return true;
    }
    const freed = packDir === undefined ? 0 : await clearStranded(packs, packDir, before, now());
    const cleared = freed > 0 ? `; removed the ${gigabytes(freed)} it had received so far` : "";
    if (fetched.outcome === "stopped") {
        log(`  ${repo}: fetch from the sandbox stopped${cleared}`);
        return false;
    }
    const reason = fetched.outcome === "failed" ? failureReason(fetched.stderr) : fetched.outcome;
    const next = nextHold(repo, hold, reason, now());
    await memory.record(repo, next);
    log(`  ${repo}: fetch from the sandbox did not finish (${HOLD_SAID[reason]})${cleared}; trying again in ${untilWhen(next.retryAt, now())}`);
    return false;
};

// The local clone made ready to follow the sandbox: a git repo, reading modes the sandbox's way, with a `sandbox` remote
// at this repo's git dir. False when one of those could not be done this pass.
const prepareClone = async (exec: BridgeExec, alias: string, dir: string, repo: string, log: Log): Promise<boolean> => {
    const url = `${alias}:/history/gits/${encodeURIComponent(repo)}`;
    if (!exec.exists(join(dir, ".git"))) {
        // A repo born in the sandbox: file sync delivered its files, this delivers its git-ness.
        if ((await exec.run("git", ["init", "-q"], dir)) === undefined) {
            return false;
        }
        log(`  ${repo}: initialized, this repo's history now follows the sandbox`);
    }
    // Mirrors the sandbox's core.fileMode=false (daemon's GIT_GLOBAL_ARGS): local git defaults true. Checked every
    // pass, not just init, since already-paired repos may predate this. `--local`, since the `-c core.fileMode=false`
    // every git here runs with would otherwise answer for the repo's own file, which the user's own git reads.
    if ((await exec.run("git", ["config", "--local", "--get", "core.fileMode"], dir))?.trim() !== "false") {
        await exec.run("git", ["config", "core.fileMode", "false"], dir);
    }
    const current = (await exec.run("git", ["remote", "get-url", "sandbox"], dir))?.trim();
    if (current === undefined) {
        return (await exec.run("git", ["remote", "add", "sandbox", url], dir)) !== undefined;
    }
    if (current !== url) {
        await exec.run("git", ["remote", "set-url", "sandbox", url], dir);
    }
    return true;
};

// Brings one local repo up to the sandbox's history, fast-forward only. Every early return leaves the repo alone
// this pass rather than touch the user's work.
export const bridgeRepo = async (
    exec: BridgeExec,
    alias: string,
    localDir: string,
    repo: string,
    log: Log,
    options: BridgeOptions = {},
): Promise<void> => {
    const memory = options.memory ?? forgetfulMemory;
    const packs = options.packs ?? realPackFs;
    const now = options.now ?? Date.now;
    const dir = join(localDir, repo);
    if (!exec.exists(dir) || !(await prepareClone(exec, alias, dir, repo, log))) {
        return;
    }
    // The one round trip a quiet repo pays for: answers branch, tip, and reachability together.
    const symref = (await exec.run("git", ["ls-remote", "--symref", "sandbox", "HEAD"], dir)) ?? "";
    const branch = /^ref:\s+refs\/heads\/(\S+)\s+HEAD/m.exec(symref)?.[1];
    // Sha line of the listing; unchecked length also matches sha256; anchor excludes origin/HEAD below.
    const remoteTip = /^([0-9a-f]+)\s+HEAD\s*$/m.exec(symref)?.[1];
    if (branch === undefined || remoteTip === undefined) {
        return; // unreachable, or an unborn HEAD in the sandbox: nothing to bridge yet
    }
    // Local and free; read before the fetch so the quiet case can be decided without one.
    const head = (await exec.run("git", ["rev-parse", "-q", "--verify", "HEAD"], dir))?.trim();
    const localBranch = (await exec.run("git", ["symbolic-ref", "--short", "-q", "HEAD"], dir))?.trim();
    // Records what the bridge itself installed into this branch, not the remote-tracking ref: a fetch advances that
    // regardless of whether HEAD followed. The ref moves only when HEAD moves.
    const bridged = `refs/intentic/bridged/${branch}`;
    const installed = (await exec.run("git", ["rev-parse", "-q", "--verify", bridged], dir))?.trim();
    if (head === remoteTip && localBranch === branch) {
        // Level with the sandbox: nothing to do, but converge the marker here too — a repo that never falls behind
        // never
        // reaches the reset that would otherwise write it. A hold has nothing left to wait for (the owner fetched by hand).
        if (head !== undefined && installed !== head) {
            await exec.run("git", ["update-ref", bridged, head], dir);
        }
        await memory.record(repo, undefined);
        return;
    }
    const hold = memory.held(repo);
    if (hold !== undefined && now() < hold.retryAt) {
        return; // said when it was held, and in the report since: not again every pass
    }
    if (!(await fetchFromSandbox({ exec, packs, memory, now, log, signal: options.signal }, dir, repo, branch, head, hold))) {
        return;
    }
    // Re-reads the tip from the fetch's ref, not the probe's: the sandbox may have committed again meanwhile.
    const tip = (await exec.run("git", ["rev-parse", "-q", "--verify", `refs/remotes/sandbox/${branch}`], dir))?.trim();
    if (tip === undefined || tip === "") {
        return;
    }
    // Anything staged is a commit the user is composing, the mixed reset below would silently unstage it.
    if (head !== undefined && (await exec.run("git", ["diff", "--cached", "--quiet"], dir)) === undefined) {
        return;
    }
    // Fast-forward only, unless local HEAD is exactly what the bridge last installed: then the sandbox rewound its
    // own history, and this follows it back.
    if (head !== undefined && head !== tip && (await exec.run("git", ["merge-base", "--is-ancestor", "HEAD", tip], dir)) === undefined) {
        if (head !== installed) {
            log(`  ${repo}: local commits diverge from the sandbox, leaving it alone`);
            return;
        }
        log(`  ${repo}: the sandbox rewound ${branch}, following it back`);
    }
    if (localBranch !== branch) {
        // Sandbox checked out a different branch (or repo was freshly initialized): follow by name via symbolic-ref,
        // which moves HEAD without touching files unless the local branch holds commits the sandbox lacks.
        const existing = (await exec.run("git", ["rev-parse", "-q", "--verify", `refs/heads/${branch}`], dir))?.trim();
        if (
            existing !== undefined &&
            existing !== "" &&
            existing !== tip &&
            // Also covers a branch the bridge installed that the sandbox has since rewound: no local work there either.
            existing !== installed &&
            (await exec.run("git", ["merge-base", "--is-ancestor", existing, tip], dir)) === undefined
        ) {
            log(`  ${repo}: local branch ${branch} diverges from the sandbox, leaving it alone`);
            return;
        }
        await exec.run("git", ["symbolic-ref", "HEAD", `refs/heads/${branch}`], dir);
    } else if (head === tip) {
        return; // already there
    }
    if ((await exec.run("git", ["reset", "-q", tip], dir)) !== undefined) {
        // Records what was just installed, right after the reset: this is the valve's only memory, and a reset whose
        // marker never lands can't be followed as a rewind later.
        await exec.run("git", ["update-ref", bridged, tip], dir);
        log(`  ${repo}: fast-forwarded ${branch} to ${tip.slice(0, 8)}`);
    }
};

// One bridge pass over a pairing's sandbox repos (sync-mode only). `known` lets the caller skip re-listing over
// ssh when the repo set is unchanged; returns the list used, or undefined if there was nothing to bridge. Never for a
// project pairing: its folder is one of the owner's own repos, whose `.git` is theirs, and the sandbox's history of it
// is a separate repository the bridge would init, re-point and reset theirs onto.
export const runGitBridge = async (
    exec: BridgeExec,
    pairing: Pairing,
    log: Log,
    known: readonly string[] | undefined,
    options: Pick<BridgeOptions, "signal" | "packs" | "now"> & { readonly memory?: BridgeMemory | undefined } = {},
): Promise<readonly string[] | undefined> => {
    if (pairing.mode !== "sync" || pairing.localDir === undefined || isProjectPairing(pairing)) {
        return undefined;
    }
    const alias = sshAlias(pairing.sandboxId);
    const repos = known ?? (await listSandboxRepos(exec, alias));
    if (repos === undefined) {
        // Named so a reader can tell which sandbox is down when one machine bridges a fleet.
        log(`  ${pairing.sandboxId}: git bridge couldn't list the sandbox's repos, will retry next pass`);
        return undefined;
    }
    // A fresh listing is the moment a deleted repo's hold can go.
    if (known === undefined && (pairing.bridgeHolds ?? []).some((hold) => !repos.includes(hold.repo))) {
        await pruneBridgeHolds(pairingKey(pairing), repos);
    }
    const memory = options.memory ?? pairingMemory(pairing);
    for (const repo of repos) {
        if (options.signal?.aborted === true) {
            break;
        }
        // one repo at a time, on purpose: they share one ssh
        // transport and log; concurrent fetches would contend for both.
        await bridgeRepo(exec, alias, pairing.localDir, repo, log, { ...options, memory });
    }
    return repos;
};

// UNDOING THE BRIDGE, for a pairing retired because its sandbox is gone (retire.ts). The bridge added a `sandbox` remote
// to each repo it followed (pointing at `<alias>:/history/gits/<repo>`), its remote-tracking refs, and the
// `refs/intentic/bridged/*` markers; once the sandbox is gone all three point at nothing, and a `git fetch --all` in that
// clone fails on the remote for good. Each is removed, and nothing else: the repo, its commits, its branches and the
// owner's own remotes stay. The repos are found where the bridge put them, one to four folders deep (isSafeRepoId), and
// only a repo whose `sandbox` remote is this alias's is touched: a remote of that name the owner made points elsewhere.

// The folders a bridged repo can be in, walked breadth-first and bounded: a workspace with a huge tree of build output
// must not turn a retirement into a crawl, and the bridge never puts a repo under what file sync ignores.
const UNBRIDGE_MAX_DIRS = 5_000;
const NEVER_A_BRIDGED_REPO: ReadonlySet<string> = new Set([
    "node_modules",
    ".git",
    "dist",
    ".cache",
    ".turbo",
    ".next",
    ".venv",
    "venv",
    ".pnpm-store",
    STATE_DIR,
    "refs",
]);

export interface UnbridgeFs {
    readonly subdirs: (dir: string) => Promise<readonly string[]>;
}

export const bridgedRepoCandidates = async (fs: UnbridgeFs, exec: BridgeExec, localDir: string): Promise<string[]> => {
    const found: string[] = [];
    let frontier = [localDir];
    let visited = 0;
    for (let depth = 0; depth < 4 && frontier.length > 0 && visited < UNBRIDGE_MAX_DIRS; depth += 1) {
        const next: string[] = [];
        for (const dir of frontier) {
            // breadth-first and bounded; a directory at a time keeps it gentle
            for (const name of await fs.subdirs(dir)) {
                visited += 1;
                if (NEVER_A_BRIDGED_REPO.has(name) || visited > UNBRIDGE_MAX_DIRS) {
                    continue;
                }
                const child = join(dir, name);
                if (exec.exists(join(child, ".git"))) {
                    found.push(child);
                }
                next.push(child);
            }
        }
        frontier = next;
    }
    return found;
};

// The remote, its tracking refs and the bridge's markers gone from every repo the bridge followed for `alias`. Answers
// how many repos were touched.
export const unbridgeRepos = async (exec: BridgeExec, fs: UnbridgeFs, alias: string, localDir: string): Promise<number> => {
    let touched = 0;
    for (const dir of await bridgedRepoCandidates(fs, exec, localDir)) {
        // one repo at a time, as the bridge itself runs
        const url = (await exec.run("git", ["remote", "get-url", "sandbox"], dir))?.trim();
        if (url === undefined || !url.startsWith(`${alias}:`)) {
            continue;
        }
        // `remote remove` takes the remote-tracking refs (refs/remotes/sandbox/*) with it.
        // ditto
        await exec.run("git", ["remote", "remove", "sandbox"], dir);
        // ditto
        const markers = (await exec.run("git", ["for-each-ref", "--format=%(refname)", "refs/intentic/bridged/"], dir)) ?? "";
        for (const ref of markers
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.startsWith("refs/intentic/bridged/"))) {
            // ditto
            await exec.run("git", ["update-ref", "-d", ref], dir);
        }
        touched += 1;
    }
    return touched;
};

export const realUnbridgeFs: UnbridgeFs = {
    subdirs: async (dir) => {
        // allow(silent-catch): this walk only looks for bridged repos to undo; a folder that vanished or cannot be listed holds none it can reach.
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        return entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => entry.name);
    },
};
