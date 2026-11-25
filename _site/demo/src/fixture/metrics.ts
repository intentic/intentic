import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import type { SandboxMetrics } from "@intentic/sandbox-contract/schemas/metrics";
import { demoMode } from "../mode";

// What GET /system/metrics answers on the demo box: a busy afternoon's readout that drifts between polls, so the
// board's geek metrics are seen moving. Every running agent gets a line and a settled one none, as on a real sandbox,
// where a finished turn's processes are gone.

const GIB = 2 ** 30;
const MIB = 2 ** 20;

// A slow swing in [-1, 1], one period a minute, phase-shifted per seed so no two figures move in step.
const swing = (now: number, seed: number): number => Math.sin((now / 60_000) * 2 * Math.PI + seed);

const tenth = (value: number): number => Math.round(value * 10) / 10;

// The full fleet (`?mode=full`) is served short of memory, as a box running too many agents is: near its limit, its swap
// full and work stalled on it, so the board's metrics show what they say when it matters (SandboxMetricsSummary's one line).
const short = demoMode.id === `full`;

export const demoMetrics = (now: number, roster: readonly AgentSummary[]): SandboxMetrics => {
    const running = roster.filter((agent) => agent.status === `running`);
    return {
        at: now,
        windowMs: 3_000,
        sandbox: {
            cpuPercent: tenth(34 + swing(now, 0) * 12),
            cores: 8,
            memoryBytes: Math.round(((short ? 15.2 : 9.4) + swing(now, 1) * 0.5) * GIB),
            memoryLimitBytes: 16 * GIB,
            ...(short && { memoryRoom: { freeBytes: Math.round(0.4 * GIB), reservedBytes: 0, personNeedBytes: GIB, stallPercent: 4, stallLimitPercent: 20 } }),
            // Sample cache-heavy cgroup accounting, separate from the process RSS groups below.
            memoryBreakdown: {
                anonymousBytes: Math.round(4.6 * GIB),
                countedFileCacheBytes: Math.round((4.2 + swing(now, 1) * 0.5) * GIB),
                kernelBytes: Math.round(0.6 * GIB),
                inactiveFileCacheBytes: Math.round(0.7 * GIB),
            },
            swapBytes: Math.round((short ? 3.9 : 0.6) * GIB),
            ...(short && { swapLimitBytes: 4 * GIB, swapFull: true }),
            diskBytes: 42 * GIB,
            diskTotalBytes: 100 * GIB,
            loadAverage: [tenth(2.4 + swing(now, 2)), 2.1, 1.8],
            machineCores: 16,
            processes: 140 + running.length * 9,
            pressure: { cpu: tenth(3.2 + swing(now, 3) * 2), memory: short ? tenth(31 + swing(now, 6) * 4) : 0.4, io: 0.8 },
        },
        daemon: { rssBytes: 320 * MIB, heapUsedBytes: 140 * MIB, cpuPercent: tenth(3.5 + swing(now, 4)), eventLoopPercent: tenth(6 + swing(now, 5) * 2) },
        sessions: Object.fromEntries(
            running.map((agent, index) => [
                agent.id,
                {
                    processes: 6 + index * 3,
                    rssBytes: Math.round((380 + index * 140 + swing(now, index) * 40) * MIB),
                    cpuPercent: tenth(45 + index * 20 + swing(now, index + 1) * 25),
                },
            ]),
        ),
        roles: {
            toolchain: { processes: 38, rssBytes: Math.round(2.8 * GIB) },
            agentRuntime: { processes: running.length + 2, rssBytes: Math.round(1.9 * GIB) },
            browser: { processes: 24, rssBytes: Math.round(1.3 * GIB) },
            languageServer: { processes: 3, rssBytes: Math.round(0.9 * GIB) },
            terminal: { processes: 14, rssBytes: 96 * MIB },
            git: { processes: 2, rssBytes: 40 * MIB },
            other: { processes: 30, rssBytes: Math.round(0.6 * GIB) },
        },
    };
};
