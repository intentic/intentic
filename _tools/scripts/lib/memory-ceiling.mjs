// A ceiling on what one test process may hold, so a runaway suite is stopped and named instead of taking the machine.
// A web worker settles near 2 to 3 GiB (test-workers.mjs), a daemon worker near 1.4 GiB; on 2026-09-25 a single bun
// process reached 14.7 GiB resident plus 31 GiB of swap, twice in one day, and every conversation on the sandbox stalled
// behind it until the owner restarted it. Nothing in a correct suite needs a sixth of that, so past the ceiling the whole
// run is killed and says why. Linux only: elsewhere there is no /proc to read and the watch does nothing.
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const GIB = 1024 ** 3;
// Twice the largest worker measured, so a heavy suite on a busy day never meets it and a leaking one does within a minute.
export const DEFAULT_CEILING_BYTES = 6 * GIB;
const NUMERIC = /^\d+$/u;

// `TEST_MEMORY_CEILING_MB`, when a caller sets one; 0 turns the watch off.
export const ceilingBytes = (env = process.env) => {
    const raw = env.TEST_MEMORY_CEILING_MB;
    if (raw === undefined || raw === "" || !Number.isFinite(Number(raw)) || Number(raw) < 0) {
        return DEFAULT_CEILING_BYTES;
    }
    return Number(raw) * 1024 ** 2;
};

const readOr = (path) => {
    try {
        return readFileSync(path, "utf8");
    } catch {
        // silent-catch: a process that exited between the listing and the read has nothing left to count
        return "";
    }
};

// `root` and every process below it, by parent pid, read in one pass over /proc.
export const processTree = (root, procRoot = "/proc") => {
    let entries;
    try {
        entries = readdirSync(procRoot);
    } catch {
        // silent-catch: no /proc (macOS, Windows) is no tree to watch
        return [];
    }
    const children = new Map();
    for (const entry of entries) {
        if (!NUMERIC.test(entry)) {
            continue;
        }
        const stat = readOr(join(procRoot, entry, "stat"));
        const ppid = Number(stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/u)[1]);
        if (Number.isInteger(ppid)) {
            (children.get(ppid) ?? children.set(ppid, []).get(ppid)).push(Number(entry));
        }
    }
    const tree = [];
    const queue = [root];
    while (queue.length > 0) {
        const pid = queue.pop();
        tree.push(pid);
        queue.push(...(children.get(pid) ?? []));
    }
    return tree;
};

// What a process holds, resident and swapped out together: a runaway on a full machine shows most of itself as swap.
export const heldBytes = (pid, procRoot = "/proc") => {
    const status = readOr(join(procRoot, String(pid), "status"));
    const kib = (field) => Number(new RegExp(`^${field}:\\s+(\\d+) kB$`, "mu").exec(status)?.[1] ?? 0);
    return (kib("VmRSS") + kib("VmSwap")) * 1024;
};

// The first process of `root`'s tree holding more than `ceiling`, with what it holds, or undefined.
export const overCeiling = (root, ceiling, procRoot = "/proc") => {
    for (const pid of processTree(root, procRoot)) {
        const held = heldBytes(pid, procRoot);
        if (held > ceiling) {
            return { pid, held };
        }
    }
    return undefined;
};

// Watches a spawned child's tree every `intervalMs`; the first process past the ceiling gets the whole tree killed and
// `onExceed` called once with it. Returns the stop function.
export const watchMemory = (child, { ceiling = ceilingBytes(), intervalMs = 2_000, onExceed, procRoot = "/proc" } = {}) => {
    if (ceiling === 0 || child.pid === undefined) {
        return () => {};
    }
    const timer = setInterval(() => {
        const found = overCeiling(child.pid, ceiling, procRoot);
        if (found === undefined) {
            return;
        }
        clearInterval(timer);
        for (const pid of processTree(child.pid, procRoot).toReversed()) {
            try {
                process.kill(pid, "SIGKILL");
            } catch {
                // silent-catch: a process already gone is the outcome the kill was for
            }
        }
        onExceed?.(found);
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
};

export const formatGiB = (bytes) => `${(bytes / GIB).toFixed(1)} GiB`;

// `node memory-ceiling.mjs -- <command> [args…]`: runs the command under the ceiling, for a caller that runs bun itself
// rather than through `suites` (flakes.mjs re-running failures alone) and waits on it synchronously.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const at = process.argv.indexOf("--");
    const [command, ...args] = at === -1 ? [] : process.argv.slice(at + 1);
    if (command === undefined) {
        console.error("usage: memory-ceiling.mjs -- <command> [args…]");
        process.exit(2);
    }
    const child = spawn(command, args, { stdio: "inherit" });
    const ceiling = ceilingBytes();
    watchMemory(child, {
        ceiling,
        onExceed: ({ pid, held }) =>
            process.stderr.write(`\nmemory-ceiling: ${command} process ${pid} held ${formatGiB(held)}, past the ${formatGiB(ceiling)} ceiling; killed.\n`),
    });
    child.on("error", (error) => {
        console.error(`memory-ceiling: ${command}: ${error.message}`);
        process.exit(1);
    });
    child.on("exit", (code, signal) => process.exit(code ?? (signal === "SIGKILL" ? 137 : 1)));
}
