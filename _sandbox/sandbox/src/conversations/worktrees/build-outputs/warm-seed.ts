import { randomBytes } from "node:crypto";
import type { Dirent } from "node:fs";
import { copyFile, link, lstat, mkdir, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { errorMessage, undefinedIfMissing } from "@intentic/base/errors";
import { defaultGit, type GitRunner } from "@intentic/base/git";
import { signalGroup } from "../../../workload/process-group.js";
import { spawnAs } from "../../../workload/workload-class.js";

// A NEW CHECKOUT'S CARGO TARGET, SEEDED FROM ONE THAT ALREADY BUILT (2026-11-19). Every conversation and spawned child
// started on an empty `target/` and compiled every dependency again: in the shinobi-society audit, 15 conversations
// rsynced a parent's or a sibling's target by hand (279 s for one copy), and their copies went wrong in exactly the way
// below. cargo-warm.ts shares one frozen target through overlay mounts, which an unprivileged sandbox cannot make; this
// copies instead, and needs no privilege.
//
// - ONLY WHAT DOES NOT DEPEND ON THE CHECKOUT'S OWN FILES IS COPIED. Cargo judges a unit fresh by comparing its sources'
//   mtimes with what it recorded, and a copied record of a crate built from the source checkout's files (its
//   uncommitted edits included) reads as fresh against a new checkout's files written earlier than that build. Measured
//   on cargo 1.100: a child cut before its parent rebuilt with an uncommitted edit, seeded by a plain `cp -a`, ran the
//   parent's edit as its own (`value: 2` from a source saying 1). So every unit of a package declared by a Cargo.toml in
//   either checkout is left out, and the new checkout compiles its own crates while reusing the registry's, git's and
//   any path dependency's outside the checkout, whose sources are the same files for both.
// - Two layouts: cargo 1.100's `build/<package>/<hash>/` (fingerprint, out and run per unit), and the older
//   `.fingerprint/<package>-<hash>/`, `build/<package>-<hash>/` and a flat `deps/` whose files carry the unit's hash.
//   `incremental/`, the uplifted files at a profile's top and `examples/` are never copied: they are the checkout's own.
// - HARD LINKS ONLY FOR .rlib AND .rmeta, everything else copied (`--reflink=auto`, a clone where the filesystem has one).
//   Measured: rustc and an sccache hit both replace those two with a new inode (the source's link count drops back to
//   1, its bytes unchanged), while Cargo truncates and rewrites fingerprints and build-script output in place, and what
//   a linker writes was not measured. Links cannot cross mounts, so a source on another mount is copied whole.
// - Copied under the source profile's own lock (`.cargo-lock`, which every cargo holds while it builds there, shared
//   since 1.100 and exclusively before) taken with a short wait: a build running there for longer means that profile is
//   left out, never copied half-written. Into a staging folder on the checkout's filesystem, moved into place by one
//   rename only if the checkout has no target yet: a build the agent started first keeps its own.

export const warmSeedsRoot = (historyRoot: string): string => join(historyRoot, "warm-seeds");

// A unit folder or fingerprint folder of the older layout, `<package>-<16 hex>`, and a `deps/` file carrying its hash.
const UNIT_DIR = /^(.+)-([0-9a-f]{16})$/u;
const HASHED_FILE = /-([0-9a-f]{16})(?:\.|$)/u;
const LINKABLE = /\.(?:rlib|rmeta)$/u;
// Cargo's lock in each profile folder.
const PROFILE_LOCK = ".cargo-lock";
// Target-level files Cargo keeps: its tag, which makes the folder build output to every sweep, and rustc's answers.
const TARGET_FILES = ["CACHEDIR.TAG", ".rustc_info.json"];
// flock(1)'s exit when the wait for the lock ran out (`-E`): a build is running in the source profile.
const BUSY = 75;
// Seconds a copy waits for a build in the source profile to finish.
const LOCK_WAIT_S = 30;
// Entries one profile's plan reads at most: a target past this is copied by nothing rather than walked for minutes.
const PLAN_BUDGET = 400_000;

// What one profile's copy is made of, profile-relative: folders to make, files to link and files to copy.
export interface ProfilePlan {
    readonly profile: string;
    readonly dirs: string[];
    readonly link: string[];
    readonly copy: string[];
    linkBytes: number;
    copyBytes: number;
}

export interface SeedLimits {
    // The most bytes the seed may write that are not hard links; a profile that would pass it is left out.
    readonly copyBytes: number;
    // When the copy is given up, epoch ms.
    readonly deadline: number;
}

export interface SeedOutcome {
    // Checkout-relative: the target seeded or not (`target`, `crates/engine/target`).
    readonly rel: string;
    readonly state: "seeded" | "skipped";
    // The checkout it came from, when one was chosen.
    readonly from?: string;
    // Why nothing was seeded, or what was left out.
    readonly reason?: string;
    readonly profiles?: readonly string[];
    readonly linkedBytes?: number;
    readonly copiedBytes?: number;
}

// The `name` a Cargo.toml's [package] table declares; a workspace's virtual manifest declares none.
export const packageNameOf = (manifest: string): string | undefined => {
    let inPackage = false;
    for (const line of manifest.split("\n")) {
        const header = /^\s*\[([^\]]+)\]/u.exec(line);
        if (header !== null) {
            inPackage = header[1]?.trim() === "package";
            continue;
        }
        const name = inPackage ? /^\s*name\s*=\s*["']([^"']+)["']/u.exec(line) : null;
        if (name?.[1] !== undefined) {
            return name[1];
        }
    }
    return undefined;
};

/**
 * Every package a Cargo.toml in these checkouts declares, tracked or not (a crate the source checkout added and never
 * committed included): the units no seed may carry. A checkout git cannot list contributes nothing, which can only
 * leave a unit in that the seed should have left out, so the caller asks of every checkout either side holds.
 */
export const localPackages = async (checkouts: readonly string[], git: GitRunner = defaultGit): Promise<Set<string>> => {
    const names = new Set<string>();
    for (const checkout of checkouts) {
        // A magic pathspec and no `--`: the runner makes every path after `--` literal, which a glob cannot be.
        const listed = await git(checkout, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", ":(glob)**/Cargo.toml"]).then(
            ({ stdout }) => stdout.split("\0").filter((path) => basename(path) === "Cargo.toml"),
            // allow(silent-catch): a checkout git cannot list declares nothing this seed can know of; the caller lists the other side too.
            () => [],
        );
        for (const path of listed) {
            const name = packageNameOf((await readFile(join(checkout, path), "utf8").catch(undefinedIfMissing)) ?? "");
            if (name !== undefined) {
                names.add(name);
            }
        }
    }
    return names;
};

const subdirsOf = async (dir: string): Promise<Dirent[]> =>
    ((await readdir(dir, { withFileTypes: true }).catch(undefinedIfMissing)) ?? []).filter((entry) => entry.isDirectory());

const holdsLock = (dir: string): Promise<boolean> => lstat(join(dir, PROFILE_LOCK)).then(
    (entry) => entry.isFile(),
    () => false,
);

// A target's profile folders, target-relative: `debug`, `release`, and under a triple `wasm32-unknown-unknown/debug`.
export const profilesOf = async (target: string): Promise<string[]> => {
    const found: string[] = [];
    for (const first of await subdirsOf(target)) {
        if (await holdsLock(join(target, first.name))) {
            found.push(first.name);
            continue;
        }
        for (const second of await subdirsOf(join(target, first.name))) {
            if (await holdsLock(join(target, first.name, second.name))) {
                found.push(`${first.name}/${second.name}`);
            }
        }
    }
    return found.toSorted();
};

// One file into the plan: an .rlib or .rmeta to link, anything else (a symlink included) to copy.
const addFile = (plan: ProfilePlan, path: string, entry: Dirent, size: number): void => {
    if (entry.isFile() && LINKABLE.test(entry.name)) {
        plan.link.push(path);
        plan.linkBytes += size;
    } else {
        plan.copy.push(path);
        plan.copyBytes += size;
    }
};

const sizeOf = async (path: string): Promise<number> => (await lstat(path).catch(undefinedIfMissing))?.size ?? 0;

// Adds one folder's whole tree to the plan, profile-relative; false once the budget is spent.
const addTree = async (plan: ProfilePlan, root: string, rel: string, budget: { left: number }): Promise<boolean> => {
    plan.dirs.push(rel);
    for (const entry of (await readdir(join(root, rel), { withFileTypes: true }).catch(undefinedIfMissing)) ?? []) {
        budget.left -= 1;
        const path = `${rel}/${entry.name}`;
        if (budget.left < 0 || (entry.isDirectory() && !(await addTree(plan, root, path, budget)))) {
            return false;
        }
        if (!entry.isDirectory()) {
            addFile(plan, path, entry, await sizeOf(join(root, path)));
        }
    }
    return true;
};

// The package a unit folder belongs to and, in the older layout, its hash.
const unitOf = (name: string): { readonly pkg: string; readonly hash?: string } => {
    const unit = UNIT_DIR.exec(name);
    return unit?.[1] === undefined || unit[2] === undefined ? { pkg: name } : { pkg: unit[1], hash: unit[2] };
};

// The unit folders of `build/` and `.fingerprint/` a new checkout may reuse, added to the plan; answers the hashes of
// the older layout's units it left out, so `deps/` leaves out their files too, or undefined past the budget.
const planUnits = async (plan: ProfilePlan, root: string, local: ReadonlySet<string>, budget: { left: number }): Promise<Set<string> | undefined> => {
    const leftOut = new Set<string>();
    for (const tree of ["build", ".fingerprint"]) {
        for (const dir of await subdirsOf(join(root, tree))) {
            const unit = unitOf(dir.name);
            if (local.has(unit.pkg)) {
                leftOut.add(unit.hash ?? "");
            } else if (!(await addTree(plan, root, `${tree}/${dir.name}`, budget))) {
                return undefined;
            }
        }
    }
    return leftOut;
};

/**
 * What of one profile folder a new checkout may reuse: every unit of a package `local` does not name. Undefined when
 * the walk ran past PLAN_BUDGET.
 */
export const planProfile = async (target: string, profile: string, local: ReadonlySet<string>): Promise<ProfilePlan | undefined> => {
    const root = join(target, profile);
    const plan: ProfilePlan = { profile, dirs: [], link: [], copy: [], linkBytes: 0, copyBytes: 0 };
    const budget = { left: PLAN_BUDGET };
    const leftOut = await planUnits(plan, root, local, budget);
    if (leftOut === undefined) {
        return undefined;
    }
    const deps = ((await readdir(join(root, "deps"), { withFileTypes: true }).catch(undefinedIfMissing)) ?? []).filter(
        (entry) => !leftOut.has(HASHED_FILE.exec(entry.name)?.[1] ?? "-"),
    );
    if (deps.length > 0) {
        plan.dirs.push("deps");
    }
    for (const entry of deps) {
        const path = `deps/${entry.name}`;
        if (!entry.isDirectory()) {
            addFile(plan, path, entry, await sizeOf(join(root, path)));
        } else if (!(await addTree(plan, root, path, budget))) {
            return undefined;
        }
    }
    return plan;
};

// Whether a file of `source` can be hard-linked into `staging`: links fail across mounts (EXDEV) even on one device.
export const linksAcross = async (sourceFile: string, staging: string): Promise<boolean> => {
    const probe = join(staging, `.link-probe-${randomBytes(4).toString("hex")}`);
    try {
        await link(sourceFile, probe);
        await unlink(probe);
        return true;
    } catch {
        // allow(silent-catch): any refusal (EXDEV, EPERM, a file gone) is an answer: copy instead of linking.
        return false;
    }
};

// Run under the source profile's lock: the folders first, then the links, then the copies, each list NUL-separated.
const COPY_SCRIPT = [
    "set -e",
    'cd "$2"',
    'xargs -0 -r mkdir -p -- < "$3"',
    'cd "$1"',
    'xargs -0 -r cp -al --parents -t "$2" -- < "$4"',
    'xargs -0 -r cp -a --reflink=auto --parents -t "$2" -- < "$5"',
].join("\n");

const nulList = (paths: readonly string[]): string => paths.map((path) => `${path}\0`).join("");

/**
 * Copies one planned profile from `source` (a target) into `staging` (a target being made) at low CPU and IO priority,
 * by `cp` under the source profile's lock. `busy` when a build held it past LOCK_WAIT_S; `late` when the deadline came
 * first. The lists are written beside the staging target, in `scratch`.
 */
const copyProfile = async (
    source: string,
    staging: string,
    plan: ProfilePlan,
    scratch: string,
    deadline: number,
): Promise<"copied" | "busy" | "late"> => {
    const lists = join(scratch, plan.profile.replaceAll("/", "_"));
    await mkdir(lists, { recursive: true });
    const files = ["dirs", "link", "copy"].map((name) => join(lists, name));
    await Promise.all([writeFile(files[0] ?? "", nulList(plan.dirs)), writeFile(files[1] ?? "", nulList(plan.link)), writeFile(files[2] ?? "", nulList(plan.copy))]);
    const from = join(source, plan.profile);
    const into = join(staging, plan.profile);
    await mkdir(into, { recursive: true });
    const wait = Math.max(1, Math.min(LOCK_WAIT_S, Math.floor((deadline - Date.now()) / 1000)));
    const flock = ["-w", String(wait), "-E", String(BUSY), join(from, PROFILE_LOCK), "sh", "-c", COPY_SCRIPT, "sh", from, into, ...files];
    const code = await new Promise<number | "late">((resolve, reject) => {
        const child = spawnAs({ class: "command" }, "flock", flock, { stdio: "ignore", detached: true });
        const timer = setTimeout(() => {
            if (child.pid !== undefined) {
                signalGroup(child.pid, "SIGKILL");
            }
            resolve("late");
        }, Math.max(0, deadline - Date.now()));
        child.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.once("close", (exit) => {
            clearTimeout(timer);
            resolve(exit ?? 1);
        });
    });
    if (code === "late") {
        return "late";
    }
    if (code === BUSY) {
        return "busy";
    }
    if (code !== 0) {
        throw new Error(`cp exited ${String(code)} copying ${from}`);
    }
    return "copied";
};

export interface SeedTargetRequest {
    // A target another checkout built, and the target the new checkout should have (absent until the seed lands).
    readonly source: string;
    readonly dest: string;
    readonly rel: string;
    readonly local: ReadonlySet<string>;
    // Where staging targets are made: on the destination's filesystem, outside every checkout (warmSeedsRoot).
    readonly stagingRoot: string;
    readonly limits: SeedLimits;
    // Asked with the bytes a profile would copy, before each; false leaves the profile out (the disk is short).
    readonly roomFor?: (bytes: number) => Promise<boolean>;
}

// What the profile loop made of a target: the profiles it holds, what it left out and why, and the bytes it wrote.
interface Copied {
    readonly profiles: string[];
    readonly left: string[];
    linkedBytes: number;
    copiedBytes: number;
    // Settled at the first file there is to link: whether this source can be linked from at all.
    linking?: boolean;
}

// One profile planned, sized against the limits and copied into the staging target; false once out of time.
const copyOne = async (request: SeedTargetRequest, profile: string, staging: string, scratch: string, done: Copied): Promise<boolean> => {
    const plan = await planProfile(request.source, profile, request.local);
    if (plan === undefined || plan.link.length + plan.copy.length === 0) {
        done.left.push(`${profile} (${plan === undefined ? "too many files" : "nothing reusable"})`);
        return true;
    }
    const first = plan.link[0];
    if (done.linking === undefined && first !== undefined) {
        done.linking = await linksAcross(join(request.source, profile, first), scratch);
    }
    const final: ProfilePlan =
        done.linking === true ? plan : { ...plan, link: [], copy: [...plan.copy, ...plan.link], linkBytes: 0, copyBytes: plan.copyBytes + plan.linkBytes };
    const total = done.copiedBytes + final.copyBytes;
    if (total > request.limits.copyBytes || (request.roomFor !== undefined && !(await request.roomFor(total)))) {
        done.left.push(`${profile} (no room to copy ${String(Math.round(final.copyBytes / 1e6))} MB)`);
        return true;
    }
    const outcome = await copyProfile(request.source, staging, final, scratch, request.limits.deadline);
    if (outcome !== "copied") {
        await rm(join(staging, profile), { recursive: true, force: true });
        done.left.push(`${profile} (${outcome === "busy" ? "a build was running there" : "out of time"})`);
        return outcome !== "late";
    }
    done.profiles.push(profile);
    done.linkedBytes += final.linkBytes;
    done.copiedBytes += final.copyBytes;
    return true;
};

// Moves a finished staging target into place, only onto nothing: a target the checkout's own build made meanwhile is
// the one it keeps.
const placeTarget = async (request: SeedTargetRequest, staging: string, done: Copied): Promise<SeedOutcome> => {
    const { rel, source, dest } = request;
    for (const name of TARGET_FILES) {
        await copyFile(join(source, name), join(staging, name)).catch(undefinedIfMissing);
    }
    if ((await lstat(dest).catch(undefinedIfMissing)) !== undefined) {
        return { rel, state: "skipped", from: source, reason: "the checkout built its own target first" };
    }
    await rename(staging, dest);
    const outcome: SeedOutcome = { rel, state: "seeded", from: source, profiles: done.profiles, linkedBytes: done.linkedBytes, copiedBytes: done.copiedBytes };
    return done.left.length === 0 ? outcome : { ...outcome, reason: `left out: ${done.left.join(", ")}` };
};

/**
 * Seeds one target from another: each profile copied while it fits the limits, then the whole moved into place by one
 * rename, only if nothing stands at `dest` by then. Never throws; what it did or why not is its answer.
 */
export const seedTarget = async (request: SeedTargetRequest): Promise<SeedOutcome> => {
    const scratch = join(request.stagingRoot, randomBytes(6).toString("hex"));
    const staging = join(scratch, "target");
    const done: Copied = { profiles: [], left: [], linkedBytes: 0, copiedBytes: 0 };
    try {
        await mkdir(staging, { recursive: true });
        for (const profile of await profilesOf(request.source)) {
            if (!(await copyOne(request, profile, staging, scratch, done))) {
                break;
            }
        }
        if (done.profiles.length === 0) {
            const reason = done.left.length === 0 ? "the source has no built profile" : `left out: ${done.left.join(", ")}`;
            return { rel: request.rel, state: "skipped", from: request.source, reason };
        }
        return await placeTarget(request, staging, done);
    } catch (error) {
        return { rel: request.rel, state: "skipped", from: request.source, reason: errorMessage(error) };
    } finally {
        await rm(scratch, { recursive: true, force: true });
    }
};
