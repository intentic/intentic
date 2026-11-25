#!/usr/bin/env node
// Shared admission formula for ResourceBudget and scripts without a daemon; dependency-free for pre-install use.
// Limit is memory.high, else memory.max, else host RAM, capped at host RAM, and never above the workload leaf's own wall
// plus what runs outside that leaf; free resident room is also capped at MemAvailable.
// Exclude reclaimable inactive cache; count swapped pages only near full swap. Memory full PSI avg10/avg60 catches paging pressure.
// I/O full PSI holds background work only: a busy disk may slow a person's turn but must not refuse it.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { request } from "node:http";
import { pathToFileURL } from "node:url";
import { namedSignature, queuedSignature } from "./heavy/command-peaks.mjs";
import { holdAtFloor, notStartedWords, waitWords } from "./heavy/memory-floor.mjs";

// The price a measured peak sets, and the line a held command is told (beside the floor's own), both part of this formula.
export { LEARNED_MIN_BYTES, LEARNED_RULE, learnedCostBytes, lineSignature, PEAK_MARGIN, peakWords } from "./heavy/command-peaks.mjs";
export { waitWords } from "./heavy/memory-floor.mjs";

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

// What a toolchain command aimed at named files takes: one bun worker over one test file, not a package's suite
// (measured 2026-10-02: a 63-test file ran in 16 ms well under 300 MiB). heavy-rules.cjs `targetedRun` decides it from
// the invocation, and queue-run passes it as `--size targeted`.
export const TARGETED_RUN_BYTES = 512 * MIB;

// What a toolchain command a heavy-command rule prices by name takes, instead of its class's cost (heavy-rules.cjs
// `size`, which queue-run passes as `--size <name>`). One name per measured shape:
export const SIZE_BYTES = Object.freeze({
    targeted: TARGETED_RUN_BYTES,
    // Shinobi resource-metrics.jsonl, 2026-11-02: `other` RSS peaked at 12.70 GiB at 19:25 with one cargo slot held,
    // and 13.88 GiB at 23:14 with two. Rust was unclassified then, so this includes other work and unqueued runs.
    // Admission estimate per slot: two fit the 18 GiB sandbox with headroom. Cargo's jobs still bound its fan-out.
    "cargo-build": 7 * GIB,
    // The editor's full typecheck, `vue-tsc` over `_editor/web`, or `_site/demo`'s, which compiles the same source:
    // 6.8 GiB at its peak (measured 2026-10-26, cold and warm alike), under the 8 GiB heap its script gives it.
    "editor-typecheck": 7 * GIB,
    // `lsp diag` on a Vue package: `vue-tsc` over the files a change touches and their direct importers
    // (_agent-tools/lsp/src/vue-check.ts). Measured 2026-10-27 on `_editor/web`, no build info: 3.9 GiB at its peak for
    // AgentsView.vue (1 changed file, 8 importers, about 1,800 files loaded), 2.0 GiB for ChatPermissionCard.vue; with
    // the build info a run leaves, 2.4 and 1.0 GiB.
    "scoped-typecheck": 4 * GIB,
});

// A price in MiB (`6144m`): what a project declares its own heavy command holds (heavy-rules.cjs classRules).
const MIB_SIZE = /^[1-9]\d{0,6}m$/u;

/** Whether `size` is a price the gate knows, by name or in MiB; any other word is priced as its class. */
export const isRoomSize = (size) => Object.hasOwn(SIZE_BYTES, size) || MIB_SIZE.test(size);

// What one test or typecheck process holds at its peak, for the scripts that size a fan-out to the free memory
// (_tools/scripts/verify/test-workers.mjs) and the ceiling that stops a runaway one (_tools/scripts/lib/memory-ceiling.mjs).
export const TEST_PROCESS_BYTES = Object.freeze({
    // One bun worker's share in a turbo fan-out: two of the four concurrent tasks are the heavy packages, so between the
    // web worker's 3 GiB and the rest.
    fanOutWorker: 1.5 * GIB,
    // One bun worker on the web package at its peak (measured 2026-09-25: 2.4 to 3.2 GiB over the web suite), the size a
    // lone `suites` run sizes to.
    standaloneWorker: 3 * GIB,
    // One typecheck task: most packages' tsgo or vue-tsc settle under 1 GiB, the web package's vue-tsc may take its 8 GiB
    // heap (measured 2026-10-06: 4.8 GiB from no build info, 1 GiB of it vue-i18n's `t` checked against the catalog;
    // 2026-10-20: 6.5 GiB, past the 6 GiB it had, which only a check seeded with build info stayed under), and at most
    // one of those runs among the others: the heavy-command table's `vue-typecheck` lane holds them to one.
    typecheck: 2 * GIB,
    // Past this one process is a leak, not a suite: twice the largest worker measured. On 2026-09-25 a single bun process
    // reached 14.7 GiB resident plus 31 GiB of swap, twice in one day, and stalled every conversation on the sandbox.
    ceiling: 6 * GIB,
});

// Work nobody is waiting on must leave room for a person's turn on top of its own cost, so it loses every tie.
export const PERSON_RESERVE_BYTES = COST_BYTES.agentRuntime;
// Percent of full avg10 at which the sandbox counts as grinding, whatever its byte count says.
export const STALL_PERCENT = 20;
// Percent of full avg60 at which it does: lower than STALL_PERCENT, since a minute's average has smoothed the spikes.
export const STALL_SUSTAINED_PERCENT = 10;
// Percent of io `full` avg10, and of avg60, at which work nobody is waiting on waits for the disk (the `disk` clause).
export const IO_STALL_PERCENT = 30;
export const IO_STALL_SUSTAINED_PERCENT = 20;
// The share of its swap limit past which swap counts as full, and the swapped pages count as used.
export const SWAP_FULL_SHARE = 0.9;
export const RESERVATION_MS = 90_000;
// Where the daemon answers `GET /room`; never the daemon's own socket, which netd relays to the internet.
export const ROOM_SOCKET = process.env.INTENTIC_ROOM_SOCKET ?? "/run/intentic/room.sock";

const CGROUP = "/sys/fs/cgroup";
// The leaf the entrypoint puts everything but netd and the daemon in, and bounds below the sandbox's cap (workloadWalls).
const WORKLOAD = `${CGROUP}/workload`;
// Every file the reading is made of, for a caller that reads them itself (the daemon, asynchronously).
export const READING_FILES = Object.freeze([
    `${CGROUP}/memory.high`,
    `${CGROUP}/memory.max`,
    `${CGROUP}/memory.current`,
    `${CGROUP}/memory.stat`,
    `${CGROUP}/memory.swap.current`,
    `${CGROUP}/memory.swap.max`,
    `${CGROUP}/memory.pressure`,
    `${CGROUP}/memory.events`,
    `${CGROUP}/io.pressure`,
    `${WORKLOAD}/memory.max`,
    `${WORKLOAD}/memory.current`,
    `${WORKLOAD}/memory.stat`,
    `${WORKLOAD}/memory.swap.current`,
    `${WORKLOAD}/memory.swap.max`,
    "/proc/meminfo",
    "/proc/pressure/memory",
    "/proc/pressure/io",
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

// One average off a PSI file's `full` line: `avg10` or `avg60`.
const fullAvg = (text, window) => {
    const line = (text ?? "").split("\n").find((entry) => entry.startsWith("full"));
    const value = line?.match(new RegExp(`${window}=([0-9.]+)`, "u"))?.[1];
    return value === undefined ? undefined : Number(value);
};

const kib = (fields, key) => (fields[key] === undefined ? undefined : fields[key] * 1024);

// One resource's PSI `full` averages: the cgroup's where it keeps one, else the machine's, avg60 from the same file avg10
// came from; 0 where nothing reports it.
const stallOf = (read, resource) => {
    const text = [read(`${CGROUP}/${resource}.pressure`), read(`/proc/pressure/${resource}`)].find((file) => fullAvg(file, "avg10") !== undefined);
    return { recent: fullAvg(text, "avg10") ?? 0, sustained: fullAvg(text, "avg60") ?? 0 };
};

// A cgroup's working set (memory.current less the inactive file cache the kernel reclaims first) and its swap, or
// undefined where it keeps no memory.current. Unaccounted swap (swapaccount off) is none, never unknown: it must not
// blank a measurable ceiling.
const chargeOf = (read, dir) => {
    const current = numeric(read(`${dir}/memory.current`));
    return current === undefined
        ? undefined
        : { residentBytes: Math.max(0, current - (keyed(read(`${dir}/memory.stat`)).inactive_file ?? 0)), swapBytes: numeric(read(`${dir}/memory.swap.current`)) ?? 0 };
};

// (2026-11-05) THE WORKLOAD LEAF'S WALLS. Everything this gate admits (a turn, a build, a test run) runs in the workload
// leaf, which the entrypoint and daemon-cgroup.ts hold below the sandbox's cap (memory-records.ts workloadMemoryMax; the swap
// default is @intentic/sandbox-run defaultSandboxSwapGib).
// On a 16 GiB cap the container's memory.high is 14.4 GiB and the leaf's memory.max 12.5 GiB, so a gate
// judging by the container alone admitted work the leaf had no room for, which then ended in an OOM kill inside the leaf
// instead of a wait for room.
//
// The leaf's wall bounds only what runs in it, so as a ceiling on the whole sandbox it is that wall plus what runs
// outside the leaf now. Outside is the container's charge less the leaf's, not the daemon leaf's own figure: the
// sandbox's own Docker containers sit beside the two leaves too. The limit less what counts against it then comes to the
// leaf's wall less the leaf's own working set, the workload judged against its own max. That is kept as a lower limit
// rather than a second reading so that used stays the whole sandbox's (the gauge, the shortage sentence and the cap a
// client offers to raise all speak of the sandbox), and every caller of the limit sees the lower wall without knowing
// the leaf exists.
//
// Swap the same way: the leaf's memory.swap.max plus what is swapped outside it (normally nothing: the daemon's leaf
// allows none), so swap counts as full once the leaf's own is nearly spent. From then on the swapped pages count against
// the limit too (countedBytesOf), and the outside's swapped pages join the offset, so the leaf is still judged by its own.
//
// A leaf that is absent, or whose bound reads `max`, is no wall, and the reading is the container's as before. A root
// cgroup has none either: with no container charge there is no inside to tell from outside.
const workloadWalls = (read, sandbox, swapLimit) => {
    const leaf = chargeOf(read, WORKLOAD);
    if (leaf === undefined) {
        return { limit: Number.POSITIVE_INFINITY, swapLimit };
    }
    const outsideResident = Math.max(0, sandbox.residentBytes - leaf.residentBytes);
    const outsideSwap = Math.max(0, sandbox.swapBytes - leaf.swapBytes);
    const swapWall = numeric(read(`${WORKLOAD}/memory.swap.max`));
    const walledSwap = Math.min(swapLimit, swapWall === undefined ? Number.POSITIVE_INFINITY : swapWall + outsideSwap);
    const wall = numeric(read(`${WORKLOAD}/memory.max`));
    if (wall === undefined) {
        return { limit: Number.POSITIVE_INFINITY, swapLimit: walledSwap };
    }
    const full = swapFullOf({ swapBytes: sandbox.swapBytes, swapLimitBytes: Number.isFinite(walledSwap) ? walledSwap : undefined });
    return { limit: wall + outsideResident + (full ? outsideSwap : 0), swapLimit: walledSwap };
};

/** The reading, from a reader that answers each of READING_FILES with its text or undefined. */
export const readingFrom = (read) => {
    const meminfo = keyed(read("/proc/meminfo"));
    const machine = kib(meminfo, "MemTotal");
    let bound = Math.min(
        numeric(read(`${CGROUP}/memory.high`)) ?? Number.POSITIVE_INFINITY,
        numeric(read(`${CGROUP}/memory.max`)) ?? Number.POSITIVE_INFINITY,
        machine ?? Number.POSITIVE_INFINITY,
    );
    const sandbox = chargeOf(read, CGROUP);
    let usedBytes;
    let swapBytes = 0;
    let swapLimit = Number.POSITIVE_INFINITY;
    if (sandbox !== undefined) {
        swapBytes = sandbox.swapBytes;
        usedBytes = sandbox.residentBytes + swapBytes;
        // The cgroup's own swap ceiling, and never more than what it holds plus what the machine's swap can still take.
        swapLimit = Math.min(numeric(read(`${CGROUP}/memory.swap.max`)) ?? Number.POSITIVE_INFINITY, swapBytes + (kib(meminfo, "SwapFree") ?? Number.POSITIVE_INFINITY));
        const walls = workloadWalls(read, sandbox, swapLimit);
        bound = Math.min(bound, walls.limit);
        swapLimit = walls.swapLimit;
    } else if (machine !== undefined && kib(meminfo, "MemAvailable") !== undefined) {
        swapBytes = Math.max(0, (kib(meminfo, "SwapTotal") ?? 0) - (kib(meminfo, "SwapFree") ?? 0));
        usedBytes = Math.max(0, machine - (kib(meminfo, "MemAvailable") ?? 0)) + swapBytes;
        swapLimit = kib(meminfo, "SwapTotal") ?? Number.POSITIVE_INFINITY;
    }
    // The cgroup's pressure where it keeps one, else the machine's; avg60 from the same file avg10 came from.
    const memory = stallOf(read, "memory");
    const disk = stallOf(read, "io");
    return {
        limitBytes: Number.isFinite(bound) ? bound : undefined,
        usedBytes,
        swapBytes,
        swapLimitBytes: Number.isFinite(swapLimit) ? swapLimit : undefined,
        availableBytes: kib(meminfo, "MemAvailable"),
        stallPercent: memory.recent,
        stallSustainedPercent: memory.sustained,
        ioStallPercent: disk.recent,
        ioStallSustainedPercent: disk.sustained,
        oomKills: keyed(read(`${CGROUP}/memory.events`)).oom_kill,
    };
};

/** Whether swap is nearly full: then the swapped pages count against the limit with the resident ones. */
export const swapFullOf = (reading) =>
    reading.swapLimitBytes !== undefined && (reading.swapBytes ?? 0) > 0 && reading.swapBytes >= SWAP_FULL_SHARE * reading.swapLimitBytes;

/** What counts against the limit: the resident part of used, and the swapped part too once swap is full. */
export const countedBytesOf = (reading) =>
    reading.usedBytes === undefined ? undefined : swapFullOf(reading) ? reading.usedBytes : reading.usedBytes - (reading.swapBytes ?? 0);

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

/** What one more of `workload` costs: its class's cost, or a named toolchain shape's where `size` names one. */
export const costBytesOf = (workload, size) =>
    workload === "toolchain" && size !== undefined && isRoomSize(size)
        ? (SIZE_BYTES[size] ?? Number(size.slice(0, -1)) * MIB)
        : (COST_BYTES[workload] ?? COST_BYTES.agentRuntime);

/** What starting one more of `workload` needs free: its own cost (`costBytes` where the caller learned it), plus a person's turn when nobody is waiting on it. */
export const needBytes = (workload, attended, size, costBytes) => (costBytes ?? costBytesOf(workload, size)) + (attended ? 0 : PERSON_RESERVE_BYTES);

/**
 * The verdict for one more of `workload`: `run`, or, when the sandbox is short, `refuse` for work a person is waiting
 * on (they are told, and decide) and `wait` for work nobody is (it is held until there is room). `reservedBytes` is what
 * other admissions still hold off the reading. An unmeasurable sandbox has no opinion, and runs.
 */
export const judge = (reading, { workload, attended, reservedBytes = 0, size, costBytes }) => {
    const need = needBytes(workload, attended, size, costBytes);
    const { limitBytes, usedBytes, swapBytes, stallPercent, availableBytes } = reading;
    const stallSustainedPercent = reading.stallSustainedPercent ?? 0;
    const unreserved = freeBytesOf(reading);
    const counted = countedBytesOf(reading);
    // Asked before the sandbox's own figures, which may measure nothing: a VM with room says nothing of the PC under it.
    const hostHeld = hostWait(reading, { workload, attended, reservedBytes, size, costBytes }, need, unreserved);
    if (hostHeld !== undefined) {
        return hostHeld;
    }
    if (limitBytes === undefined || usedBytes === undefined || counted === undefined || unreserved === undefined) {
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
    if (stallSustainedPercent >= STALL_SUSTAINED_PERCENT) {
        return shortOf(`The sandbox is short of memory: for ${Math.round(stallSustainedPercent)}% of the last minute, everything in it was waiting on memory`);
    }
    const disk = attended ? undefined : diskStalled(reading);
    if (disk !== undefined) {
        return shortOf(disk);
    }
    if (freeBytes >= need) {
        return { verdict: "run", needBytes: need, freeBytes, reservedBytes };
    }
    // The machine, not the sandbox's own limit, is what ran out: saying "9 of 16 GiB used" would read as a wrong refusal.
    if (availableBytes !== undefined && availableBytes < limitBytes - counted) {
        const held = reservedBytes > 0 ? `, and ${gib(reservedBytes)} held for work that just started` : "";
        return shortOf(`Sandbox memory is low: the machine it runs on has ${gib(availableBytes)} available${held}`);
    }
    // Resident and swapped are named apart once paging starts: the limit bounds resident pages only, so their sum can
    // exceed it, and "19.2 GiB of 16.0 GiB used" reads as a bug. Free is counted against the resident part alone, until
    // swap is full and the sentence says so, since that is what made the swapped part count.
    const used =
        swapBytes > 0
            ? `${gib(usedBytes - swapBytes)} resident + ${gib(swapBytes)} swapped, against ${gib(limitBytes)}${swapFullOf(reading) ? ", with swap full" : ""}`
            : `${gib(usedBytes)} of ${gib(limitBytes)} used`;
    // Named, or a sandbox reading 3 GiB free would seem to refuse work that needs 2.
    const held = reservedBytes > 0 ? `, and ${gib(reservedBytes)} held for work that just started` : "";
    return shortOf(`Sandbox memory is low: ${used}${held}`, { limitBytes, residentBytes: usedBytes - swapBytes, swapBytes });
};

// (2026-11-02) Why work nobody is waiting on should wait for the machine this sandbox runs on, or undefined while it need
// not. Everything else here reads the sandbox's own cgroup and the kernel under it, which on a Windows PC is Docker
// Desktop's WSL2 VM: on 2026-11-02 that VM read as roomy while Windows had 1.1 GB left and froze for 43 s. The daemon adds
// `reading.host` from what the host's agent last said (hosts/host-memory.ts), only while that is fresh, so a reading
// without it is "no host to answer to", never "no room". Work waits while starting it would take the host below its
// reserve, the line under which the host's agent starts giving the VM's cache back. Only the work's own cost counts here:
// the person's share in `needBytes` is room inside the sandbox, which the sandbox's own figures already keep.
const hostShortOf = (host, costBytes, reservedBytes) => {
    if (host === undefined || host.availableBytes - host.reserveBytes - reservedBytes >= costBytes) {
        return undefined;
    }
    const held = reservedBytes > 0 ? `, ${gib(reservedBytes)} of it held for work that just started` : "";
    return `${host.name}, the machine this sandbox runs on, is low on memory: it has ${gib(host.availableBytes)} available of ${gib(host.totalBytes)}${held}, and heavy work waits while starting it would leave it under ${gib(host.reserveBytes)}`;
};

// The verdict that holds work nobody waits on for the host, or undefined while the host has room for it (hostShortOf).
const hostWait = (reading, { workload, attended, reservedBytes, size, costBytes }, need, unreserved) => {
    const diagnosis = attended ? undefined : hostShortOf(reading.host, costBytes ?? costBytesOf(workload, size), reservedBytes);
    return diagnosis === undefined
        ? undefined
        : { verdict: "wait", needBytes: need, freeBytes: unreserved === undefined ? undefined : Math.max(0, unreserved - reservedBytes), reservedBytes, diagnosis };
};

// Why work nobody is waiting on should wait for the disk, or undefined while it need not (the `disk` clause).
const diskStalled = (reading) => {
    const recent = reading.ioStallPercent ?? 0;
    const sustained = reading.ioStallSustainedPercent ?? 0;
    if (recent >= IO_STALL_PERCENT) {
        return `The sandbox's disk is saturated: for ${Math.round(recent)}% of the last ten seconds, everything in it was waiting on the disk`;
    }
    return sustained >= IO_STALL_SUSTAINED_PERCENT
        ? `The sandbox's disk is saturated: for ${Math.round(sustained)}% of the last minute, everything in it was waiting on the disk`
        : undefined;
};

/**
 * Free memory as the formula counts it (the limit less what counts against it: the resident part, and swap too once swap
 * is full), or undefined where nothing bounds or measures it.
 */
export const freeBytesOf = (reading) => {
    const counted = countedBytesOf(reading);
    return reading.limitBytes === undefined || counted === undefined
        ? undefined
        : Math.max(0, Math.min(reading.limitBytes - counted, reading.availableBytes ?? Number.POSITIVE_INFINITY));
};

// ---- asking the daemon, with the formula itself as the fallback ----

// One GET on the room socket, as parsed JSON; undefined for any failure. No socket (CI, a plain checkout), a daemon
// restarting, a hung or unparsable answer: the formula decides instead.
const getJson = (socketPath, path, timeoutMs) =>
    new Promise((resolve) => {
        const asked = request({ socketPath, path, method: "GET", timeout: timeoutMs }, (response) => {
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

// `start` is the pid's start, by which the daemon finds that process in its own pid namespace to measure it.
const askSocket = (workload, waitSeconds, label, socketPath, size, pid, signature) => {
    const query = new URLSearchParams({ class: workload, wait: String(waitSeconds), label });
    if (size !== undefined) {
        query.set("size", size);
    }
    if (pid !== undefined) {
        query.set("pid", String(pid));
    }
    if (signature !== undefined) {
        query.set("key", signature.key);
        query.set("command", signature.command);
        query.set("start", String(signature.start));
    }
    return getJson(socketPath, `/room?${query}`, (waitSeconds + 15) * 1000);
};

const askSnapshot = (socketPath) => getJson(socketPath, "/snapshot", 3_000);

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

// (2026-11-17, the shinobi-society audit) A held command that starts anyway at its deadline gains nothing from the wait
// when waiting cannot help: in three days that sandbox's heavy commands waited ~50 hours for room (p50 27 s, p90 129 s),
// and most then printed "still short of memory after 120s — starting anyway". Waiting helps while admitted work holds a
// reservation (it ends within RESERVATION_MS, or as its process grows into the reading) or while the shortage eases; a
// wait that has seen neither for STUCK_MS is given up, and the command starts now rather than at the deadline.
export const STUCK_MS = 30_000;
// What counts as easing over that window: free memory up by at least this much.
export const EASED_BYTES = 512 * MIB;

/**
 * Whether a wait for room has stopped helping: `observe(judged, at)` with each look's verdict and its time answers true
 * once STUCK_MS of looks have passed with nothing reserved and free memory not up by EASED_BYTES.
 */
export const stuckWait = ({ stuckMs = STUCK_MS, easedBytes = EASED_BYTES } = {}) => {
    let since;
    let base = 0;
    return {
        observe: (judged, at) => {
            const free = judged.freeBytes ?? 0;
            if (since === undefined || judged.reservedBytes > 0 || free - base >= easedBytes) {
                since = at;
                base = free;
                return false;
            }
            return at - since >= stuckMs;
        },
    };
};

/**
 * The daemon's verdict for one more of `workload`, waiting up to `waitSeconds` for room; where no daemon answers, the
 * same formula over the same files, polled every `intervalMs`. Never throws: every failure is an answer of `run`.
 * `size` prices a toolchain command by its named shape (SIZE_BYTES: `targeted` for one aimed at named files); `pid` is the process the
 * admitted work runs as, whose exit hands its reservation back at once instead of after RESERVATION_MS. `signature` names the
 * command it runs (queuedSignature), which the daemon prices by its measured peak; the formula alone learns nothing.
 */
export const askRoom = async ({
    workload = "toolchain",
    waitSeconds = 0,
    label = "command",
    socketPath = ROOM_SOCKET,
    intervalMs = 5_000,
    read = readReadingSync,
    size,
    pid,
    signature,
    stuckMs = STUCK_MS,
} = {}) => {
    const answered = await askSocket(workload, waitSeconds, label, socketPath, size, pid, signature);
    if (answered !== undefined) {
        return { ...answered, source: "daemon" };
    }
    const startedAt = Date.now();
    let verdict = judge(read(), { workload, attended: false, size });
    const waitedFor = verdict.diagnosis;
    const stuck = stuckWait({ stuckMs });
    let gaveUp = false;
    while (verdict.verdict !== "run" && Date.now() - startedAt < waitSeconds * 1000) {
        gaveUp = stuck.observe(verdict, Date.now());
        if (gaveUp) {
            break;
        }
        await sleep(intervalMs);
        verdict = judge(read(), { workload, attended: false, size });
    }
    const answer = { ...verdict, waitedMs: Date.now() - startedAt, source: "formula" };
    if (waitedFor !== undefined) {
        answer.waitedFor = waitedFor;
    }
    if (gaveUp) {
        answer.stuck = true;
    }
    return answer;
};

// What the command line asks for; `--pid` (queue-run's) names the command it runs, priced by what it took last time.
const askedOf = (option) => {
    const label = option("label", "command");
    const number = Number(option("pid", ""));
    const pid = Number.isInteger(number) && number > 1 ? number : undefined;
    return {
        workload: option("class", "toolchain"),
        label,
        intervalMs: Math.max(50, Number(option("interval-ms", "5000")) || 5000),
        size: isRoomSize(option("size", "")) ? option("size", "") : undefined,
        pid,
        signature: pid === undefined ? undefined : (namedSignature(pid, option("key", undefined), option("command", undefined)) ?? queuedSignature(pid, label)),
    };
};

// What the daemon holds for an admitted command: its rule's price, or what it took last time where that is more; 0 for none.
const admittedBytes = (answer, asked) =>
    answer.verdict === "run" && answer.source === "daemon" ? (answer.costBytes ?? costBytesOf(asked.workload, asked.size)) : 0;

// `memory-room --class toolchain --wait 120 [--ceiling 900] --label NAME [--size targeted|cargo-build|6144m|…] [--pid PID]
// [--key K --command C] [--admitted]` holds a command until there is room, saying why it waited (`--key`/`--command` name
// what queue-run's argv cannot: an agent's queued line). Short of room at `--wait` it starts anyway, unless less than the
// floor is free: then it waits up to `--ceiling` and, still below it, exits 75 so the command is not started
// (heavy/memory-floor.mjs). Every other outcome exits 0: a gate that cannot read the sandbox must not be the reason a
// command did not run. `--admitted` prints what the daemon holds for the command (0 for none), for its launcher to size
// its jobs to; `--json` prints the answer instead; `--free` prints the free memory as the daemon counts it.
const main = async (args) => {
    const option = (name, fallback) => {
        const at = args.indexOf(`--${name}`);
        return at === -1 ? fallback : (args[at + 1] ?? fallback);
    };
    if (args.includes("--free")) {
        process.stdout.write(`${JSON.stringify(await askFree({ socketPath: option("socket", ROOM_SOCKET) }))}\n`);
        return 0;
    }
    const waitSeconds = Math.max(0, Number(option("wait", "0")) || 0);
    const startedAt = Date.now();
    const asked = askedOf(option);
    const label = asked.label;
    let answer = await askRoom({ ...asked, waitSeconds });
    if (answer.verdict !== "run") {
        const ceilingSeconds = Math.max(waitSeconds, Number(option("ceiling", "0")) || 0);
        const say = (line) => process.stderr.write(`${line}\n`);
        answer = await holdAtFloor({ answer, ask: (seconds) => askRoom({ ...asked, waitSeconds: seconds }), label, ceilingSeconds, say, startedAt });
        if (answer.notStarted === true && !args.includes("--json")) {
            say(notStartedWords(label, answer, answer.waitedMs));
        }
    }
    if (args.includes("--admitted")) {
        process.stdout.write(`${admittedBytes(answer, asked)}\n`);
    }
    if (args.includes("--json")) {
        process.stdout.write(`${JSON.stringify(answer)}\n`);
    } else if (answer.notStarted !== true) {
        const words = waitWords(label, answer);
        if (words !== undefined) {
            process.stderr.write(`${words}\n`);
        }
    }
    return answer.notStarted === true ? 75 : 0;
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
    const code = await main(process.argv.slice(2)).catch((error) => {
        process.stderr.write(`[memory-room] skipped: ${error instanceof Error ? error.message : String(error)}\n`);
        return 0;
    });
    process.exit(code);
}
