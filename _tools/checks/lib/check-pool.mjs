import { spawnSync } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { availableParallelism, tmpdir, totalmem } from "node:os";
import { join } from "node:path";

// A fixed machine budget, shared by invocations in every worktree. flock owns the lifetime: a crash cannot
// strand a slot. Platforms without flock still bound each invocation rather than starting every check at once.
export const checkPool = (env = process.env) => {
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
    return { size, command: (slot, file, args) => shared ? ["flock", ["--exclusive", join(dir, `slot-${slot}`), file, ...args]] : [file, args] };
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
