import { describe, expect, test } from "bun:test";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { DAEMON_OWNER, ONE_SHOT_OWNER, WORKLOAD_ENV } from "../../seams/workload-stamp.js";
import {
    createLiveMetrics,
    type DaemonReading,
    daemonUsageOf,
    keyedValue,
    type LiveMetricsSource,
    type MachineReading,
    parseAuxv,
    type ProcessSample,
    quotaCores,
    sandboxUsageOf,
    sessionsOf,
    totalsOf,
} from "./live-metrics.js";

/* What GET /system/metrics answers and what it costs to answer. Every figure is checked against the fake /proc below,
 * whose counters these tests move by hand, so a CPU percentage is an exact expectation rather than a range. */

const PAGE = 4096;
const TICKS = 100;
const DAEMON_PID = 1000;

interface FakeProcess {
    comm: string;
    owner?: string;
    cmdline?: string;
    // Own user+system ticks, and ticks of reaped children (cutime+cstime), as /proc/<pid>/stat reports them.
    ticks: number;
    reaped?: number;
    rssPages: number;
    start?: number;
}

// One /proc/<pid>/stat line, with utime/stime and cutime/cstime split so the parser's sums are exercised.
const statLine = (pid: number, process: FakeProcess): string =>
    `${pid} (${process.comm}) S 1 ${pid} ${pid} 0 -1 4194304 0 0 0 0 ${process.ticks} 0 ${process.reaped ?? 0} 0 20 0 1 0 ${process.start ?? 7} 1000000 ${process.rssPages}`;

interface FakeHost {
    readonly source: LiveMetricsSource;
    readonly processes: Map<number, FakeProcess>;
    readonly files: Map<string, string>;
    // Every path read, in order, so a test can say what a reading cost.
    readonly reads: string[];
    clock: number;
    daemon: DaemonReading;
    listings: number;
}

const machine: MachineReading = { cores: 8, totalMemoryBytes: 32 * 2 ** 30, freeMemoryBytes: 20 * 2 ** 30, loadAverage: [1.5, 1.25, 1] };

const fakeHost = (processes: Record<number, FakeProcess>, files: Record<string, string> = {}): FakeHost => {
    const host: FakeHost = {
        processes: new Map(Object.entries(processes).map(([pid, process]) => [Number(pid), process])),
        files: new Map(Object.entries(files)),
        reads: [],
        clock: 1_000_000,
        daemon: { pid: DAEMON_PID, rssBytes: 300 * 2 ** 20, heapUsedBytes: 120 * 2 ** 20, cpuMicros: 0, loopActiveMs: 0, loopIdleMs: 0 },
        listings: 0,
        source: {
            listPids: async () => {
                host.listings += 1;
                return [DAEMON_PID, ...host.processes.keys()];
            },
            readText: async (path) => {
                host.reads.push(path);
                const match = /^\/proc\/(\d+)\/(stat|environ|cmdline|cgroup)$/u.exec(path);
                if (match === null) {
                    return host.files.get(path);
                }
                const pid = Number(match[1]);
                const process = host.processes.get(pid);
                if (process === undefined) {
                    return undefined;
                }
                switch (match[2]) {
                    case "stat": {
                        return statLine(pid, process);
                    }
                    case "environ": {
                        return ["PATH=/usr/bin", ...(process.owner === undefined ? [] : [`${WORKLOAD_ENV}=${process.owner}`])].join("\0");
                    }
                    case "cmdline": {
                        return (process.cmdline ?? process.comm).replaceAll(" ", "\0");
                    }
                    default: {
                        return "0::/";
                    }
                }
            },
            disk: async () => ({ usedBytes: 40 * 2 ** 30, totalBytes: 200 * 2 ** 30 }),
            units: async () => ({ pageBytes: PAGE, ticksPerSecond: TICKS }),
            daemon: () => host.daemon,
            machine: () => machine,
            now: () => host.clock,
        },
    };
    return host;
};

const identityReads = (host: FakeHost, pid: number): number => host.reads.filter((path) => path === `/proc/${pid}/environ`).length;

// Moves one live process's counters, the way time passing does.
const change = (host: FakeHost, pid: number, counters: Partial<Pick<FakeProcess, "ticks" | "reaped">>): void => {
    const process = host.processes.get(pid);
    if (process === undefined) {
        throw new Error(`no fake process ${pid}`);
    }
    host.processes.set(pid, { ...process, ...counters });
};

describe("units and cgroup files", () => {
    test("page size and clock rate come from the auxiliary vector, in either byte order", () => {
        const auxv = (littleEndian: boolean, pairs: readonly (readonly [number, number])[]): Buffer => {
            const buffer = Buffer.alloc(pairs.length * 16);
            const write = (value: number, offset: number): number =>
                littleEndian ? buffer.writeBigUInt64LE(BigInt(value), offset) : buffer.writeBigUInt64BE(BigInt(value), offset);
            pairs.forEach(([key, value], index) => {
                write(key, index * 16);
                write(value, index * 16 + 8);
            });
            return buffer;
        };
        expect(parseAuxv(auxv(true, [[33, 5], [6, 16_384], [17, 250], [0, 0]]), true)).toEqual({ pageBytes: 16_384, ticksPerSecond: 250 });
        expect(parseAuxv(auxv(false, [[6, 65_536], [17, 100], [0, 0]]), false)).toEqual({ pageBytes: 65_536, ticksPerSecond: 100 });
        // A vector that names neither falls back to what every shipped platform uses, rather than to a zero divisor.
        expect(parseAuxv(Buffer.alloc(0), true)).toEqual({ pageBytes: 4096, ticksPerSecond: 100 });
    });

    test("a CPU quota is cores; `max` is none", () => {
        expect(quotaCores("150000 100000\n")).toBe(1.5);
        expect(quotaCores("max 100000\n")).toBeUndefined();
        expect(quotaCores(undefined)).toBeUndefined();
    });

    test("a flat-keyed cgroup file is read by whole key, not by prefix", () => {
        const stat = "usage_usec 14857435323\nuser_usec 11580537798\nsystem_usec 3276897525\n";
        expect(keyedValue(stat, "usage_usec")).toBe(14_857_435_323);
        expect(keyedValue("active_file 5\ninactive_file 7\n", "inactive_file")).toBe(7);
        expect(keyedValue("active_file 5\n", "file")).toBeUndefined();
    });
});

describe("attributing processes", () => {
    const sample = (owner: string | undefined, role: ProcessSample["role"], rssBytes: number, ticks: number): ProcessSample => ({ owner, role, rssBytes, ticks });

    test("a conversation's figures are its stamped processes; pools and unstamped work count only by kind", () => {
        const totals = totalsOf([
            sample("conv-a", "agentRuntime", 300, 50),
            sample("conv-a", "toolchain", 700, 25),
            sample("conv-b", "browser", 900, 10),
            sample(DAEMON_OWNER, "agentRuntime", 400, 5),
            sample(ONE_SHOT_OWNER, "agentRuntime", 100, 1),
            sample(undefined, "languageServer", 800, 2),
        ]);
        expect(Object.fromEntries(totals.owners)).toEqual({
            "conv-a": { processes: 2, rssBytes: 1000, ticks: 75 },
            "conv-b": { processes: 1, rssBytes: 900, ticks: 10 },
        });
        expect(totals.roles).toEqual({
            agentRuntime: { processes: 3, rssBytes: 800 },
            toolchain: { processes: 1, rssBytes: 700 },
            browser: { processes: 1, rssBytes: 900 },
            languageServer: { processes: 1, rssBytes: 800 },
        });
        expect(totals.ticks).toBe(93);
    });

    test("CPU is the growth of a conversation's ticks over the window, as a percentage of one core", () => {
        const totals = totalsOf([sample("steady", "agentRuntime", 1, 450), sample("shrunk", "agentRuntime", 1, 10), sample("new", "toolchain", 1, 60)]);
        const baseline = new Map([
            ["steady", 150],
            ["shrunk", 200],
        ]);
        expect(sessionsOf(totals, baseline, 3_000, TICKS)).toEqual({
            // 300 ticks at 100/s is 3 s of CPU in a 3 s window: one full core.
            steady: { processes: 1, rssBytes: 1, cpuPercent: 100 },
            // A member left mid-window taking its ticks along; that is not negative work.
            shrunk: { processes: 1, rssBytes: 1, cpuPercent: 0 },
            // Absent from the baseline means started inside the window, so every tick it has is the window's.
            new: { processes: 1, rssBytes: 1, cpuPercent: 20 },
        });
        expect(sessionsOf(totals, undefined, undefined, TICKS)).toEqual({
            steady: { processes: 1, rssBytes: 1 },
            shrunk: { processes: 1, rssBytes: 1 },
            new: { processes: 1, rssBytes: 1 },
        });
    });
});

describe("the sandbox and the daemon", () => {
    const cgroup = {
        cpuStat: "usage_usec 100\n",
        cpuMax: "200000 100000\n",
        memoryCurrent: `${10 * 2 ** 30}\n`,
        memoryMax: `${16 * 2 ** 30}\n`,
        memoryStat: `anon 1\nfile 2\ninactive_file ${3 * 2 ** 30}\n`,
        swapCurrent: `${2 ** 30}\n`,
        pressure: {
            cpu: "some avg10=1.50 avg60=0.00 avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n",
            memory: "some avg10=12.25 avg60=0.00 avg300=0.00 total=1\nfull avg10=3.00 avg60=0.00 avg300=0.00 total=0\n",
            io: "some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n",
        },
    };

    test("memory is the working set against the container's limit, and CPU is against its quota", () => {
        expect(sandboxUsageOf({ cgroup, machine, disk: { usedBytes: 5, totalBytes: 9 }, processes: 42, coresUsed: 0.5 })).toEqual({
            cpuPercent: 25,
            cores: 2,
            memoryBytes: 7 * 2 ** 30,
            memoryLimitBytes: 16 * 2 ** 30,
            swapBytes: 2 ** 30,
            diskBytes: 5,
            diskTotalBytes: 9,
            loadAverage: [1.5, 1.25, 1],
            processes: 42,
            pressure: { cpu: 1.5, memory: 12.25, io: 0 },
        });
    });

    test("without a cgroup it reads the machine, and says nothing it cannot see", () => {
        const none = {
            cpuStat: undefined,
            cpuMax: undefined,
            memoryCurrent: undefined,
            memoryMax: "max\n",
            memoryStat: undefined,
            swapCurrent: undefined,
            pressure: { cpu: undefined, memory: undefined, io: undefined },
        };
        expect(sandboxUsageOf({ cgroup: none, machine, disk: undefined, processes: 3, coresUsed: undefined })).toEqual({
            cores: 8,
            memoryBytes: 12 * 2 ** 30,
            memoryLimitBytes: 32 * 2 ** 30,
            loadAverage: [1.5, 1.25, 1],
            processes: 3,
        });
    });

    test("a limit above the machine's memory is the machine's memory", () => {
        const loose = { ...cgroup, memoryMax: `${64 * 2 ** 30}\n` };
        expect(sandboxUsageOf({ cgroup: loose, machine, disk: undefined, processes: 1, coresUsed: undefined }).memoryLimitBytes).toBe(32 * 2 ** 30);
    });

    test("the daemon's CPU is of one core and its loop figure is the busy share of loop time", () => {
        const before: DaemonReading = { pid: 1, rssBytes: 1, heapUsedBytes: 1, cpuMicros: 1_000_000, loopActiveMs: 100, loopIdleMs: 900 };
        const now: DaemonReading = { pid: 1, rssBytes: 7, heapUsedBytes: 3, cpuMicros: 1_600_000, loopActiveMs: 400, loopIdleMs: 3_600 };
        expect(daemonUsageOf(now, before, 2_000)).toEqual({ rssBytes: 7, heapUsedBytes: 3, cpuPercent: 30, eventLoopPercent: 10 });
        expect(daemonUsageOf(now, undefined, undefined)).toEqual({ rssBytes: 7, heapUsedBytes: 3 });
    });
});

describe("a reading", () => {
    const stamped = (): FakeHost =>
        fakeHost(
            {
                10: { comm: "claude", owner: "conv-a", ticks: 1_000, rssPages: 25_600 },
                11: { comm: "bash", owner: "conv-a", ticks: 5, rssPages: 1_024 },
                20: { comm: "node", owner: DAEMON_OWNER, cmdline: "node /opt/gemini --acp", ticks: 50, rssPages: 51_200 },
                30: { comm: "tsgo", cmdline: "tsgo --lsp --stdio", ticks: 9, rssPages: 2_048 },
            },
            { "/sys/fs/cgroup/cpu.stat": "usage_usec 5000000\n" },
        );

    test("the first one has memory and no CPU: there is nothing earlier to measure from", async () => {
        const host = stamped();
        const metrics = await createLiveMetrics({ workspaceRoot: WORKSPACE_ROOT, source: host.source }).read();
        expect(metrics.windowMs).toBeUndefined();
        expect(metrics.sandbox.cpuPercent).toBeUndefined();
        expect(metrics.daemon).toEqual({ rssBytes: 300 * 2 ** 20, heapUsedBytes: 120 * 2 ** 20 });
        expect(metrics.sessions).toEqual({ "conv-a": { processes: 2, rssBytes: 26_624 * PAGE } });
        expect(metrics.roles).toEqual({
            agentRuntime: { processes: 2, rssBytes: (25_600 + 51_200) * PAGE },
            terminal: { processes: 1, rssBytes: 1_024 * PAGE },
            languageServer: { processes: 1, rssBytes: 2_048 * PAGE },
        });
        // The daemon counts as running, and is never scanned: its figures are its own.
        expect(metrics.sandbox.processes).toBe(5);
        expect(host.reads).not.toContain(`/proc/${DAEMON_PID}/stat`);
    });

    test("the next one measures CPU since the first, a command that finished and was reaped included", async () => {
        const host = stamped();
        const live = createLiveMetrics({ workspaceRoot: WORKSPACE_ROOT, source: host.source });
        await live.read();

        host.clock += 2_000;
        host.daemon = { ...host.daemon, cpuMicros: 200_000, loopActiveMs: 50, loopIdleMs: 1_950 };
        host.files.set("/sys/fs/cgroup/cpu.stat", "usage_usec 9000000\n");
        // The agent ran for a second and its bash finished a 0.5 s command it reaped: all of it is the conversation's.
        change(host, 10, { ticks: 1_100 });
        change(host, 11, { reaped: 50 });

        const metrics = await live.read();
        expect(metrics.windowMs).toBe(2_000);
        expect(metrics.sessions["conv-a"]).toEqual({ processes: 2, rssBytes: 26_624 * PAGE, cpuPercent: 75 });
        // 4 s of cgroup CPU in 2 s on 8 cores.
        expect(metrics.sandbox.cpuPercent).toBe(25);
        expect(metrics.daemon).toEqual({ rssBytes: 300 * 2 ** 20, heapUsedBytes: 120 * 2 ** 20, cpuPercent: 10, eventLoopPercent: 2.5 });
    });

    test("a process is identified once in its life, and again only when its pid now names someone else", async () => {
        const host = stamped();
        const live = createLiveMetrics({ workspaceRoot: WORKSPACE_ROOT, source: host.source });
        await live.read();
        host.clock += 2_000;
        await live.read();
        expect(identityReads(host, 10)).toBe(1);

        // Same pid, a later start: the old process exited and the kernel reused its number.
        host.processes.set(10, { comm: "node", owner: "conv-b", ticks: 3, rssPages: 10, start: 99 });
        host.clock += 2_000;
        const metrics = await live.read();
        expect(identityReads(host, 10)).toBe(2);
        expect(Object.keys(metrics.sessions).toSorted()).toEqual(["conv-a", "conv-b"]);
    });

    test("boards asking together cost one scan, and one asking again within a second is answered from it", async () => {
        const host = stamped();
        const live = createLiveMetrics({ workspaceRoot: WORKSPACE_ROOT, source: host.source });
        const [first, second] = await Promise.all([live.read(), live.read()]);
        expect(second).toBe(first);
        host.clock += 500;
        expect(await live.read()).toBe(first);
        expect(host.listings).toBe(1);

        host.clock += 600;
        expect((await live.read()).at).toBe(host.clock);
        expect(host.listings).toBe(2);
    });

    test("after a quiet spell the reading carries no CPU rather than an average over it", async () => {
        const host = stamped();
        const live = createLiveMetrics({ workspaceRoot: WORKSPACE_ROOT, source: host.source });
        await live.read();
        host.clock += 60_000;
        const late = await live.read();
        expect(late.windowMs).toBeUndefined();
        expect(late.sessions["conv-a"]).toEqual({ processes: 2, rssBytes: 26_624 * PAGE });

        // It becomes the baseline, so the one after it measures again.
        host.clock += 3_000;
        expect((await live.read()).windowMs).toBe(3_000);
    });

    test("a process gone between the listing and its read is simply not counted", async () => {
        const host = stamped();
        const listed = host.source.listPids;
        const live = createLiveMetrics({
            workspaceRoot: WORKSPACE_ROOT,
            source: { ...host.source, listPids: async () => [...(await listed()), 4_242] },
        });
        expect((await live.read()).sandbox.processes).toBe(5);
    });
});
