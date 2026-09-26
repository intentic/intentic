import type { AgentSummary, SandboxMetrics } from "@intentic/sandbox-contract";

// What GET /system/metrics answers on the demo box: a busy afternoon's readout that drifts between polls, so the
// board's geek metrics are seen moving. Every running agent gets a line and a settled one none, as on a real sandbox,
// where a finished turn's processes are gone.

const GIB = 2 ** 30;
const MIB = 2 ** 20;

// A slow swing in [-1, 1], one period a minute, phase-shifted per seed so no two figures move in step.
const swing = (now: number, seed: number): number => Math.sin((now / 60_000) * 2 * Math.PI + seed);

const tenth = (value: number): number => Math.round(value * 10) / 10;

export const demoMetrics = (now: number, roster: readonly AgentSummary[]): SandboxMetrics => {
    const running = roster.filter((agent) => agent.status === `running`);
    return {
        at: now,
        windowMs: 3_000,
        sandbox: {
            cpuPercent: tenth(34 + swing(now, 0) * 12),
            cores: 8,
            memoryBytes: Math.round((9.4 + swing(now, 1) * 0.5) * GIB),
            memoryLimitBytes: 16 * GIB,
            swapBytes: Math.round(0.6 * GIB),
            diskBytes: 42 * GIB,
            diskTotalBytes: 100 * GIB,
            loadAverage: [tenth(2.4 + swing(now, 2)), 2.1, 1.8],
            machineCores: 16,
            processes: 140 + running.length * 9,
            pressure: { cpu: tenth(3.2 + swing(now, 3) * 2), memory: 0.4, io: 0.8 },
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
            searchEngine: { processes: 1, rssBytes: Math.round(0.45 * GIB) },
            terminal: { processes: 14, rssBytes: 96 * MIB },
            git: { processes: 2, rssBytes: 40 * MIB },
            other: { processes: 30, rssBytes: Math.round(0.6 * GIB) },
        },
    };
};
