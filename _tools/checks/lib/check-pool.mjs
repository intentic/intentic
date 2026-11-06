import { spawn, spawnSync } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { availableParallelism, tmpdir, totalmem } from "node:os";
import { join } from "node:path";

// A fixed machine budget, shared by invocations in every worktree. flock owns the lifetime: a crash cannot
// strand a slot. Platforms without flock still bound each invocation rather than starting every check at once.
const budget = (env) => {
    let memory = totalmem();
    try {
        const limit = Number(readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim());
        if (Number.isFinite(limit) && limit > 0) {memory = Math.min(memory, limit);}
    } catch {
        // allow(silent-catch): cgroup limits are optional on development hosts; physical memory supplies the budget.
    }
    const size = Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2), Math.floor(memory / (2 * 1024 ** 3))));
    // The existing queue root is shared into fenced turns too; their private TMPDIR would split the budget.
    const dir = join(env.INTENTIC_QUEUE_DIR ?? join(tmpdir(), "intentic-queue"), `checks-${process.getuid?.() ?? "user"}`);
    let shared = process.platform === "linux" && spawnSync("flock", ["--version"], { stdio: "ignore" }).status === 0;
    if (shared) {
        try {
            mkdirSync(dir, { recursive: true, mode: 0o700 });
        } catch {
            // allow(silent-catch): an unwritable shared queue falls back to the local bound; checks still run.
            shared = false;
        }
    }
    return { size, dir, shared };
};

export const checkPool = (env = process.env) => {
    const { size, dir, shared } = budget(env);
    return { size, command: (slot, file, args) => shared ? ["flock", ["--exclusive", join(dir, `slot-${slot}`), file, ...args]] : [file, args] };
};

// Takes the first free slot of the lane; when every one is taken, waits on each in turn a moment at a time, so the
// first slot given back is the one taken. `exec cat` then holds the lock until its stdin closes.
const HOLD = `dir=$1; size=$2; i=0; tries=0
while :; do
    exec 9>"$dir/edit-$i"
    if [ "$tries" -lt "$size" ]; then wait=--nonblock; else wait="--timeout 0.2"; fi
    if flock $wait 9; then echo held; exec cat >/dev/null; fi
    i=$(((i + 1) % size)); tries=$((tries + 1))
done`;

// THE LANE OF A RUN THAT JUDGES A FEW FILES (run.mjs --paths, after every edit): slots of its own beside the whole-tree
// ones, under the same budget. In the shared slots one edit's checks waited out whatever check a turn's or a CI-like
// whole-tree run held each slot with, up to the edit's 60s ceiling; here it waits only for other edits, about a second
// each. Resolves once a slot is held, to the function that gives it back. The holder is a shell whose stdin is this
// process, so a crash or a kill gives the slot back too. Without flock, or when the holder cannot start, it runs unbounded.
export const editLane = (env = process.env) => {
    const { size, dir, shared } = budget(env);
    if (!shared) {
        return Promise.resolve(() => {});
    }
    return new Promise((resolve) => {
        const holder = spawn("sh", ["-c", HOLD, "sh", dir, String(size)], { stdio: ["pipe", "pipe", "ignore"] });
        const release = () => holder.stdin.end();
        holder.on("error", () => resolve(() => {}));
        holder.on("exit", () => resolve(() => {}));
        // A holder already gone has given its slot back; closing its stdin then has nothing left to say.
        holder.stdin.on("error", () => resolve(() => {}));
        holder.stdout.once("data", () => resolve(release));
    });
};

// Results keep manifest order even when checks finish out of order. A worker holds at most one child at once.
export const pooledMap = async (items, size, run) => {
    const results = Array.from({ length: items.length });
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(size, items.length) }, async (_, slot) => {
        while (next < items.length) {
            const at = next++;
            results[at] = await run(items[at], slot);
        }
    }));
    return results;
};
