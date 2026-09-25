#!/usr/bin/env node
// Whether this sandbox has room for more work, by one formula: the daemon's ResourceBudget
// (_sandbox/sandbox/src/platform/resources/resource-budget.ts) judges every turn, child and heavy command with it and
// serves the verdict on a local socket, and the scripts that run where no daemon answers (CI, a plain checkout, a
// daemon restarting) apply the same functions to the same files. Plain JavaScript with no dependencies, so a script
// imports it by path before any install, and `memory-room` runs it as a command.
//
//   limit  memory.high (where the kernel starts throttling the whole cgroup), else memory.max, else the machine's
//          memory, never more than the machine's
//   used   the working set (memory.current less the inactive file cache the kernel reclaims first) plus what was
//          pushed to swap; at a root cgroup, which has no memory.current, the machine's own used memory and swap
//   free   limit − used, and never more than the machine itself has available (MemAvailable): a sandbox on a
//          shared machine cannot take memory the machine does not have, whatever its own limit says
//   stall  memory PSI `full avg10`: the share of the last ten seconds in which everything waited on memory
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { request } from "node:http";
import { pathToFileURL } from "node:url";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

// What starting one more of each workload class takes out of the sandbox (keys: WorkloadClass in workload-class.ts).
// A reservation holds it for RESERVATION_MS, until the reading shows what the work grew into; a runner fits its memory
// divided by an agent's cost.
export const COST_BYTES = Object.freeze({
    // A runtime, its MCP servers and the first commands it runs.
    agentRuntime: GIB,
    service: 512 * MIB,
    panel: 512 * MIB,
    install: GIB,
    command: 256 * MIB,
    // A build, test or typecheck a heavy-command rule matched; the queue's slots bound how many run at once.
    toolchain: GIB,
});

// What one test or typecheck process holds at its peak, for the scripts that size a fan-out to the free memory
// (_tools/scripts/verify/test-workers.mjs) and the ceiling that stops a runaway one (_tools/scripts/lib/memory-ceiling.mjs).
export const TEST_PROCESS_BYTES = Object.freeze({
    // One bun worker's share in a turbo fan-out: two of the four concurrent tasks are the heavy packages, so between the
    // web worker's 3 GiB and the rest.
    fanOutWorker: 1.5 * GIB,
    // One bun worker on the web package at its peak (measured 2026-09-25: 2.4 to 3.2 GiB over the web suite), the size a
    // lone `suites` run sizes to.
    standaloneWorker: 3 * GIB,
    // One typecheck task: most packages' tsgo or vue-tsc settle under 1 GiB, the web package's vue-tsc may take its 4 GiB
    // heap, and at most one of those runs among the others.
    typecheck: 2 * GIB,
    // Past this one process is a leak, not a suite: twice the largest worker measured. On 2026-09-25 a single bun process
    // reached 14.7 GiB resident plus 31 GiB of swap, twice in one day, and stalled every conversation on the sandbox.
    ceiling: 6 * GIB,
});

// Work nobody is waiting on must leave room for a person's turn on top of its own cost, so it loses every tie.
export const PERSON_RESERVE_BYTES = COST_BYTES.agentRuntime;
// Percent of full avg10 at which the sandbox counts as grinding, whatever its byte count says.
export const STALL_PERCENT = 20;
export const RESERVATION_MS = 90_000;
// Where the daemon answers `GET /room`; never the daemon's own socket, which the front relays to the internet.
export const ROOM_SOCKET = process.env.INTENTIC_ROOM_SOCKET ?? "/run/intentic/room.sock";

const CGROUP = "/sys/fs/cgroup";
// Every file the reading is made of, for a caller that reads them itself (the daemon, asynchronously).
export const READING_FILES = Object.freeze([
    `${CGROUP}/memory.high`,
    `${CGROUP}/memory.max`,
    `${CGROUP}/memory.current`,
    `${CGROUP}/memory.stat`,
    `${CGROUP}/memory.swap.current`,
    `${CGROUP}/memory.pressure`,
    `${CGROUP}/memory.events`,
    "/proc/meminfo",
    "/proc/pressure/memory",
]);

const numeric = (text) => {
    const trimmed = text?.trim() ?? "";
    return /^\d+$/u.test(trimmed) ? Number(trimmed) : undefined;
};

// `key value` lines, and meminfo's `Key:   value kB`.
const keyed = (text) =>
    Object.fromEntries(
        (text ?? "")
            .split("\n")
            .map((line) => line.trim().replace(/\s+kB$/u, "").split(/\s+/u))
            .filter((parts) => parts.length === 2 && Number.isFinite(Number(parts[1])))
            .map(([key, value]) => [key.replace(/:$/u, ""), Number(value)]),
    );

const fullAvg10 = (text) => {
    const line = (text ?? "").split("\n").find((entry) => entry.startsWith("full"));
    const value = line?.match(/avg10=([0-9.]+)/u)?.[1];
    return value === undefined ? undefined : Number(value);
};

const kib = (fields, key) => (fields[key] === undefined ? undefined : fields[key] * 1024);

/** The reading, from a reader that answers each of READING_FILES with its text or undefined. */
export const readingFrom = (read) => {
    const meminfo = keyed(read("/proc/meminfo"));
    const machine = kib(meminfo, "MemTotal");
    const bound = Math.min(
        numeric(read(`${CGROUP}/memory.high`)) ?? Number.POSITIVE_INFINITY,
        numeric(read(`${CGROUP}/memory.max`)) ?? Number.POSITIVE_INFINITY,
        machine ?? Number.POSITIVE_INFINITY,
    );
    const current = numeric(read(`${CGROUP}/memory.current`));
    let usedBytes;
    let swapBytes = 0;
    if (current !== undefined) {
        // Unaccounted swap (swapaccount off) is none, never unknown: it must not blank a measurable ceiling.
        swapBytes = numeric(read(`${CGROUP}/memory.swap.current`)) ?? 0;
        usedBytes = Math.max(0, current - (keyed(read(`${CGROUP}/memory.stat`)).inactive_file ?? 0)) + swapBytes;
    } else if (machine !== undefined && kib(meminfo, "MemAvailable") !== undefined) {
        swapBytes = Math.max(0, (kib(meminfo, "SwapTotal") ?? 0) - (kib(meminfo, "SwapFree") ?? 0));
        usedBytes = Math.max(0, machine - (kib(meminfo, "MemAvailable") ?? 0)) + swapBytes;
    }
    return {
        limitBytes: Number.isFinite(bound) ? bound : undefined,
        usedBytes,
        swapBytes,
        availableBytes: kib(meminfo, "MemAvailable"),
        stallPercent: fullAvg10(read(`${CGROUP}/memory.pressure`)) ?? fullAvg10(read("/proc/pressure/memory")) ?? 0,
        oomKills: keyed(read(`${CGROUP}/memory.events`)).oom_kill,
    };
};

const readSync = (path) => {
    try {
        return readFileSync(path, "utf8");
    } catch {
        // allow(silent-catch): a file this kernel or platform does not have is the absent reading every caller handles
        return undefined;
    }
};

export const readReadingSync = () => readingFrom(readSync);

const gib = (bytes) => `${(bytes / GIB).toFixed(1)} GiB`;

/** What starting one more of `workload` needs free: its own cost, plus a person's turn when nobody is waiting on it. */
export const needBytes = (workload, attended) => (COST_BYTES[workload] ?? COST_BYTES.agentRuntime) + (attended ? 0 : PERSON_RESERVE_BYTES);

/**
 * The verdict for one more of `workload`: `run`, or, when the sandbox is short, `refuse` for work a person is waiting
 * on (they are told, and decide) and `wait` for work nobody is (it is held until there is room). `reservedBytes` is what
 * other admissions still hold off the reading. An unmeasurable sandbox has no opinion, and runs.
 */
export const judge = (reading, { workload, attended, reservedBytes = 0 }) => {
    const need = needBytes(workload, attended);
    const { limitBytes, usedBytes, swapBytes, stallPercent, availableBytes } = reading;
    const unreserved = freeBytesOf(reading);
    if (limitBytes === undefined || usedBytes === undefined || unreserved === undefined) {
        return { verdict: "run", needBytes: need, freeBytes: undefined, reservedBytes };
    }
    const freeBytes = Math.max(0, unreserved - reservedBytes);
    const shortOf = (diagnosis, memory) => ({
        verdict: attended ? "refuse" : "wait",
        needBytes: need,
        freeBytes,
        reservedBytes,
        diagnosis,
        ...(memory === undefined ? {} : { memory }),
    });
    // PSI is the sandbox's own only under a cgroup; at the root it is the machine's, and still the one there is.
    if (stallPercent >= STALL_PERCENT) {
        return shortOf(`The sandbox is short of memory: for ${Math.round(stallPercent)}% of the last ten seconds, everything in it was waiting on memory`);
    }
    if (freeBytes >= need) {
        return { verdict: "run", needBytes: need, freeBytes, reservedBytes };
    }
    // The machine, not the sandbox's own limit, is what ran out: saying "9 of 16 GiB used" would read as a wrong refusal.
    if (availableBytes !== undefined && availableBytes < limitBytes - usedBytes) {
        const held = reservedBytes > 0 ? `, and ${gib(reservedBytes)} held for work that just started` : "";
        return shortOf(`Sandbox memory is low: the machine it runs on has ${gib(availableBytes)} available${held}`);
    }
    // Resident and swapped are named apart once paging starts: the limit bounds resident pages only, so their sum can
    // exceed it, and "19.2 GiB of 16.0 GiB used" reads as a bug.
    const used =
        swapBytes > 0
            ? `${gib(usedBytes - swapBytes)} resident + ${gib(swapBytes)} swapped, against ${gib(limitBytes)}`
            : `${gib(usedBytes)} of ${gib(limitBytes)} used`;
    // Named, or a sandbox reading 3 GiB free would seem to refuse work that needs 2.
    const held = reservedBytes > 0 ? `, and ${gib(reservedBytes)} held for work that just started` : "";
    return shortOf(`Sandbox memory is low: ${used}${held}`, { limitBytes, residentBytes: usedBytes - swapBytes, swapBytes });
};

/** Free memory as the formula counts it, or undefined where nothing bounds or measures it. */
export const freeBytesOf = (reading) =>
    reading.limitBytes === undefined || reading.usedBytes === undefined
        ? undefined
        : Math.max(0, Math.min(reading.limitBytes - reading.usedBytes, reading.availableBytes ?? Number.POSITIVE_INFINITY));

// ---- asking the daemon, with the formula itself as the fallback ----

const askSocket = (workload, waitSeconds, label, socketPath) =>
    new Promise((resolve) => {
        const query = new URLSearchParams({ class: workload, wait: String(waitSeconds), label });
        const asked = request({ socketPath, path: `/room?${query}`, method: "GET", timeout: (waitSeconds + 15) * 1000 }, (response) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => (body += chunk));
            response.on("end", () => {
                try {
                    resolve(response.statusCode === 200 ? JSON.parse(body) : undefined);
                } catch {
                    // allow(silent-catch): an answer that does not parse is no answer; the formula below decides instead
                    resolve(undefined);
                }
            });
        });
        // No socket (CI, a plain checkout), a daemon restarting, a hung answer: the formula below decides instead.
        asked.on("error", () => resolve(undefined));
        asked.on("timeout", () => asked.destroy());
        asked.end();
    });

const askSnapshot = (socketPath) =>
    new Promise((resolve) => {
        const asked = request({ socketPath, path: "/snapshot", method: "GET", timeout: 3_000 }, (response) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => (body += chunk));
            response.on("end", () => {
                try {
                    resolve(response.statusCode === 200 ? JSON.parse(body) : undefined);
                } catch {
                    // allow(silent-catch): an answer that does not parse is no answer; the formula below decides instead
                    resolve(undefined);
                }
            });
        });
        asked.on("error", () => resolve(undefined));
        asked.on("timeout", () => asked.destroy());
        asked.end();
    });

/**
 * Free memory as the daemon counts it (the reading less what work it admitted still holds), for a caller that sizes
 * itself rather than asking to start; where no daemon answers, the formula's own free memory.
 */
export const askFree = async ({ socketPath = ROOM_SOCKET, read = readReadingSync } = {}) => {
    const snapshot = await askSnapshot(socketPath);
    return snapshot === undefined ? { freeBytes: freeBytesOf(read()), source: "formula" } : { freeBytes: snapshot.freeBytes, source: "daemon" };
};

// The same, for a caller that cannot wait on a promise (a script's default argument): this module run as a command.
export const askFreeSync = ({ socketPath = ROOM_SOCKET } = {}) => {
    if (existsSync(socketPath)) {
        const run = spawnSync(process.execPath, [import.meta.filename, "--free", "--socket", socketPath], { encoding: "utf8", timeout: 5_000 });
        try {
            const answer = JSON.parse(run.stdout);
            if (typeof answer.freeBytes === "number") {
                return answer.freeBytes;
            }
        } catch {
            // allow(silent-catch): a daemon that did not answer leaves the formula to decide, below
        }
    }
    return freeBytesOf(readReadingSync());
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The daemon's verdict for one more of `workload`, waiting up to `waitSeconds` for room; where no daemon answers, the
 * same formula over the same files, polled every `intervalMs`. Never throws: every failure is an answer of `run`.
 */
export const askRoom = async ({ workload = "toolchain", waitSeconds = 0, label = "command", socketPath = ROOM_SOCKET, intervalMs = 5_000, read = readReadingSync } = {}) => {
    const answered = await askSocket(workload, waitSeconds, label, socketPath);
    if (answered !== undefined) {
        return { ...answered, source: "daemon" };
    }
    const startedAt = Date.now();
    let verdict = judge(read(), { workload, attended: false });
    while (verdict.verdict !== "run" && Date.now() - startedAt < waitSeconds * 1000) {
        await sleep(intervalMs);
        verdict = judge(read(), { workload, attended: false });
    }
    return { ...verdict, waitedMs: Date.now() - startedAt, source: "formula" };
};

// `memory-room --class toolchain --wait 120 --label NAME` holds a command until there is room, printing why it waited,
// and always exits 0: a gate that cannot read the sandbox must not be the reason a command did not run. `--json` prints
// the answer instead; `--free` prints the free memory as the daemon counts it, for a caller that sizes itself to it.
const main = async (args) => {
    const option = (name, fallback) => {
        const at = args.indexOf(`--${name}`);
        return at === -1 ? fallback : (args[at + 1] ?? fallback);
    };
    if (args.includes("--free")) {
        process.stdout.write(`${JSON.stringify(await askFree({ socketPath: option("socket", ROOM_SOCKET) }))}\n`);
        return;
    }
    const waitSeconds = Math.max(0, Number(option("wait", "0")) || 0);
    const label = option("label", "command");
    const answer = await askRoom({ workload: option("class", "toolchain"), waitSeconds, label, intervalMs: Math.max(50, Number(option("interval-ms", "5000")) || 5000) });
    if (args.includes("--json")) {
        process.stdout.write(`${JSON.stringify(answer)}\n`);
        return;
    }
    const free = answer.freeBytes === undefined ? "?" : gib(answer.freeBytes);
    if (answer.waitedMs > 0) {
        process.stderr.write(
            answer.verdict === "run"
                ? `[memory-room] ${label}: waited ${Math.round(answer.waitedMs / 1000)}s for memory, ${free} free — starting.\n`
                : `[memory-room] ${label}: still short of memory after ${Math.round(answer.waitedMs / 1000)}s (${free} free) — starting anyway.\n`,
        );
    }
};

const invokedAs = process.argv[1] === undefined ? undefined : (() => {
    try {
        return pathToFileURL(realpathSync(process.argv[1])).href;
    } catch {
        // allow(silent-catch): an argv[1] that is not a file is not this module being run as a command
        return undefined;
    }
})();
if (invokedAs === import.meta.url) {
    await main(process.argv.slice(2)).catch((error) => process.stderr.write(`[memory-room] skipped: ${error instanceof Error ? error.message : String(error)}\n`));
    process.exit(0);
}
