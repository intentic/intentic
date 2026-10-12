// A ceiling on what one test process may hold, so a runaway suite is stopped and named instead of taking the machine.
// A web worker settles near 2 to 3 GiB (test-workers.mjs), a daemon worker near 1.4 GiB; on 2026-09-25 a single bun
// process reached 14.7 GiB resident plus 31 GiB of swap, twice in one day, and every conversation on the sandbox stalled
// behind it until the owner restarted it. Nothing in a correct suite needs a sixth of that, so past the ceiling the whole
// run is killed and says why. Linux only: elsewhere there is no /proc to read and the watch does nothing.
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { TEST_PROCESS_BYTES } from "../../constants/src/memory-room.mjs";

const GIB = 1024 ** 3;
// Twice the largest worker measured, so a heavy suite on a busy day never meets it and a leaking one does within a minute
// (memory-room.mjs keeps the measurement).
export const DEFAULT_CEILING_BYTES = TEST_PROCESS_BYTES.ceiling;
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
        // allow(silent-catch): a process that exited between the listing and the read has nothing left to count
        return "";
    }
};

// `root` and every process below it, by parent pid, read in one pass over /proc.
export const processTree = (root, procRoot = "/proc") => {
    let entries;
    try {
        entries = readdirSync(procRoot);
    } catch {
        // allow(silent-catch): no /proc (macOS, Windows) is no tree to watch
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

// The process of `root`'s tree holding the most, with what it holds, or undefined for a tree with nothing in it.
export const largestProcess = (root, procRoot = "/proc") => {
    let largest;
    for (const pid of processTree(root, procRoot)) {
        const held = heldBytes(pid, procRoot);
        if (held > (largest?.held ?? 0)) {
            largest = { pid, held };
        }
    }
    return largest;
};

// Watches a spawned child's tree every `intervalMs`; the first process past the ceiling gets the whole tree killed and
// `onExceed` called once with it. Returns the stop function, which answers with the most any one process of the tree
// was seen holding, and the most the whole tree held at one look (`total`), or undefined when nothing was sampled: how
// close a run came is the measurement the ceiling is sized from, and a run that passes says nothing of it otherwise. The
// ceiling is per process, so a fan-out of four workers at 3 GiB each is 3 GiB against it and 12 GiB of the machine.
export const watchMemory = (child, { ceiling = ceilingBytes(), intervalMs = 2_000, onExceed, procRoot = "/proc" } = {}) => {
    if (ceiling === 0 || child.pid === undefined) {
        return () => undefined;
    }
    let peak;
    const timer = setInterval(() => {
        const tree = processTree(child.pid, procRoot);
        const held = tree.map((pid) => ({ pid, held: heldBytes(pid, procRoot) }));
        const largest = held.reduce((most, entry) => (entry.held > (most?.held ?? 0) ? entry : most), undefined);
        const total = held.reduce((sum, entry) => sum + entry.held, 0);
        if (largest !== undefined) {
            peak = largest.held > (peak?.held ?? 0) ? { ...largest, total: Math.max(total, peak?.total ?? 0) } : { ...peak, total: Math.max(total, peak.total) };
        }
        const found = held.find((entry) => entry.held > ceiling);
        if (found === undefined) {
            return;
        }
        clearInterval(timer);
        for (const pid of tree.toReversed()) {
            try {
                process.kill(pid, "SIGKILL");
            } catch {
                // allow(silent-catch): a process already gone is the outcome the kill was for
            }
        }
        onExceed?.(found);
    }, intervalMs);
    timer.unref();
    return () => {
        clearInterval(timer);
        return peak;
    };
};

export const formatGiB = (bytes) => `${(bytes / GIB).toFixed(1)} GiB`;

// A size as a reader takes it: in GiB from one GiB up, in MiB below, where a light suite's 37 MiB printed as "0.0 GiB"
// and read as a broken measurement.
export const formatSize = (bytes) => (bytes >= GIB ? formatGiB(bytes) : `${Math.round(bytes / 1024 ** 2)} MiB`);

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
