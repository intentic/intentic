import { existsSync, readFileSync } from "node:fs";
import { totalmem } from "node:os";
import { join } from "node:path";

/* THE TREES OFFLOADED LINES RUN IN, a few per repo on one runner. A tree is kept between runs with everything git
   ignores (node_modules, a Rust target/ of tens of gigabytes), which is what makes the second run of a build cheap. Two
   lines in one tree at once would check out over each other mid-build, so each run leases a tree of its own: the
   warmest free one (the one used last, its build outputs closest to the next snapshot), a new one while the pool has
   room, else it waits for one to come free. The first tree keeps the path a runner always used, so its warm outputs
   survive this pool's arrival. */

// One tree per this much of the runner's memory, between one and MAX_TREES: a heavy build is what a tree is for, and
// the runner's own queue holds the next one back anyway when memory is short.
const BYTES_PER_TREE = 8 * 1024 ** 3;
const MAX_TREES = 3;

export const treeSlotPath = (offloadRoot: string, repo: string, slot: number): string =>
    join(offloadRoot, slot === 0 ? encodeURIComponent(repo) : `${encodeURIComponent(repo)}~${String(slot + 1)}`);

// The memory this container may use (cgroup v2's memory.max), else the machine's.
const memoryCeiling = (): number => {
    try {
        const limit = readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim();
        if (/^\d+$/u.test(limit)) {
            return Number(limit);
        }
    } catch {
        // allow(silent-catch): no cgroup v2 file means no container limit; the machine's memory is the ceiling
    }
    return totalmem();
};

export const treesFor = (memoryBytes: number = memoryCeiling()): number => Math.max(1, Math.min(MAX_TREES, Math.floor(memoryBytes / BYTES_PER_TREE)));

export interface TreeLease {
    readonly tree: string;
    readonly release: () => void;
}

export interface TreePool {
    readonly acquire: (repo: string, signal: AbortSignal, say: (text: string) => void) => Promise<TreeLease>;
}

interface RepoTrees {
    readonly busy: Set<number>;
    readonly lastUsed: Map<number, number>;
    readonly waiters: Array<() => void>;
}

export const createTreePool = (offloadRoot: string, maxTrees: number): TreePool => {
    const repos = new Map<string, RepoTrees>();
    const stateOf = (repo: string): RepoTrees => {
        let state = repos.get(repo);
        if (state === undefined) {
            state = { busy: new Set(), lastUsed: new Map(), waiters: [] };
            repos.set(repo, state);
        }
        return state;
    };

    // The free tree to use: one already made over a new one (its outputs are warm), the most recently used of those, then
    // the lowest slot. Undefined when every slot the pool allows is busy.
    const pick = (repo: string, state: RepoTrees): number | undefined => {
        const free = Array.from({ length: maxTrees }, (_, slot) => slot).filter((slot) => !state.busy.has(slot));
        const made = (slot: number): boolean => existsSync(join(treeSlotPath(offloadRoot, repo, slot), ".git"));
        return free.toSorted(
            (left, right) =>
                Number(made(right)) - Number(made(left)) || (state.lastUsed.get(right) ?? 0) - (state.lastUsed.get(left) ?? 0) || left - right,
        )[0];
    };

    const acquire = async (repo: string, signal: AbortSignal, say: (text: string) => void): Promise<TreeLease> => {
        const state = stateOf(repo);
        let slot = pick(repo, state);
        if (slot === undefined) {
            say(`every offload tree of ${repo} here is busy (${String(maxTrees)}); waiting for one to come free`);
        }
        while (slot === undefined) {
            signal.throwIfAborted();
            await new Promise<void>((resolve) => {
                const wake = (): void => {
                    signal.removeEventListener("abort", wake);
                    resolve();
                };
                state.waiters.push(wake);
                signal.addEventListener("abort", wake, { once: true });
            });
            signal.throwIfAborted();
            slot = pick(repo, state);
        }
        const leased = slot;
        state.busy.add(leased);
        let released = false;
        return {
            tree: treeSlotPath(offloadRoot, repo, leased),
            release: () => {
                if (released) {
                    return;
                }
                released = true;
                state.busy.delete(leased);
                state.lastUsed.set(leased, Date.now());
                state.waiters.shift()?.();
            },
        };
    };

    return { acquire };
};
