import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import type { Logger } from "pino";
import { readText } from "../../../system/resources/cgroup.js";
import { listPids } from "../../../system/resources/process-scan.js";
import { namedByProgram, readRunningPrograms, type RunningProgram } from "../../../system/resources/storage/running-programs.js";
import { cargoTagged, removeQuietly } from "./build-outputs.js";

// CARGO TARGETS LEFT IN /tmp (2026-11-03). Agents kept their checkout's `target/` out of the checkout by pointing
// CARGO_TARGET_DIR under /tmp (shinobi's /tmp held 11 GB of them), where nothing ever removed one: not the checkout
// sweep, which never looks there, and not a restart, since /tmp is the container's own layer. They cannot be handed to
// the conversation that made them: a Claude Code turn's TMPDIR is the shared /tmp, every turn writes as the same user,
// and a folder records no author, so "once its conversation is archived" has no reliable answer. What can be said for
// certain is Cargo's own tag on the folder, how long since any build wrote to it, and whether a running process names
// it; a tagged folder untouched for IDLE_MS that nothing running points at goes, through the same low-priority removal
// as the checkouts' (build-outputs.ts). A later build there rebuilds it, which is all removing build output costs.

export const IDLE_MS = 24 * 60 * 60 * 1000;

// How deep below /tmp a target may sit (`/tmp/x`, `/tmp/x/target`), and how deep inside one its builds leave fresh
// folders (`debug/deps`, `wasm32-unknown-unknown/release/deps`): a rebuild renames into those, which moves their time.
const FIND_DEPTH = 2;
const FRESHNESS_DEPTH = 3;

const subdirs = async (dir: string): Promise<string[]> => {
    const entries: Dirent[] = (await readdir(dir, { withFileTypes: true }).catch(undefinedIfMissing)) ?? [];
    return entries.filter((entry) => entry.isDirectory()).map((entry) => join(dir, entry.name));
};

// Cargo-tagged folders up to FIND_DEPTH below `root`; never entered once found, links never followed.
export const findTmpTargets = async (root: string, depth = 1): Promise<string[]> => {
    const found: string[] = [];
    for (const dir of await subdirs(root)) {
        if (await cargoTagged(dir)) {
            found.push(dir);
        } else if (depth < FIND_DEPTH) {
            found.push(...(await findTmpTargets(dir, depth + 1)));
        }
    }
    return found;
};

// The latest a build touched the folder: its own time and that of every folder FRESHNESS_DEPTH below it.
const lastBuiltAt = async (dir: string, depth = 0): Promise<number> => {
    const own = (await lstat(dir).catch(undefinedIfMissing))?.mtimeMs ?? 0;
    if (depth >= FRESHNESS_DEPTH) {
        return own;
    }
    const below = await Promise.all((await subdirs(dir)).map((child) => lastBuiltAt(child, depth + 1)));
    return Math.max(own, ...below);
};

// Every CARGO_TARGET_DIR a running process was started with: a build waiting in the queue names its target only there.
const runningTargetDirs = async (): Promise<string[]> => {
    const dirs = await Promise.all(
        (await listPids()).map(async (pid) => {
            const environ = (await readText(`/proc/${String(pid)}/environ`)) ?? "";
            const entry = environ.split("\0").find((pair) => pair.startsWith("CARGO_TARGET_DIR="));
            return entry === undefined ? [] : [entry.slice("CARGO_TARGET_DIR=".length)];
        }),
    );
    return dirs.flat();
};

export interface TmpTargetDeps {
    readonly root: string;
    readonly now: number;
    readonly logger: Pick<Logger, "info" | "warn">;
    readonly programs?: () => Promise<readonly RunningProgram[]>;
    readonly targetDirs?: () => Promise<readonly string[]>;
    readonly remove?: (path: string) => Promise<void>;
}

const inside = (path: string, dir: string): boolean => path === dir || path.startsWith(`${dir}/`) || dir.startsWith(`${path}/`);

export const reapTmpCargoTargets = async (deps: TmpTargetDeps): Promise<string[]> => {
    const candidates = await findTmpTargets(deps.root);
    if (candidates.length === 0) {
        return [];
    }
    const [programs, targetDirs] = await Promise.all([(deps.programs ?? readRunningPrograms)(), (deps.targetDirs ?? runningTargetDirs)()]);
    const removed: string[] = [];
    for (const dir of candidates) {
        if (namedByProgram(programs, dir) || targetDirs.some((target) => inside(target, dir))) {
            continue;
        }
        if (deps.now - (await lastBuiltAt(dir)) < IDLE_MS) {
            continue;
        }
        try {
            await (deps.remove ?? removeQuietly)(dir);
            removed.push(dir);
        } catch (error) {
            deps.logger.warn({ err: error, dir }, "storage: could not remove an idle Cargo target from /tmp; the next pass tries again");
        }
    }
    if (removed.length > 0) {
        deps.logger.info({ removed }, "storage: removed idle Cargo target directories from /tmp");
    }
    return removed;
};
