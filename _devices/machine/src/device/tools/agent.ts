import { pollUntil } from "@intentic/base/async";
import { readTextIfExists } from "@intentic/base/fs";
import { isProcessAlive, spawnDetached } from "@intentic/local-agent";
import type { DeviceAgentOp } from "@intentic/sandbox-contract/schemas/devices";
import { agentLogPath } from "../../config.js";
import { installedBuild } from "../../installed.js";
import { machineLauncher } from "../../resident/supervision.js";
import { SWAP_WAIT_MAX_MS } from "../sandbox-rounds/swap-records.js";
import { onFileChange } from "./programs/file-changes.js";
import { icSwapsInFlight } from "./sandboxes.js";

// Updates or restarts this device's own agent, asked for from the browser. Both operations stop the process
// serving this socket, so the work is detached (spawnDetached) and tailed back rather than spawned inline,
// which would die with an EPIPE mid-swap. The daemon admits only a maintainer to this dedicated flow; agents reach
// this device through MCP instead, so their command scope has no say in this owner action.

// `intentic-machine <verb…>`; the op is a closed enum in the contract and this is the whole mapping. Every one is a TASK:
// it does its work and exits, often within spawnDetached's settle window, which must not read that as a crash.
export const AGENT_VERB: Record<DeviceAgentOp, readonly string[]> = {
    upgrade: ["upgrade"],
    restart: ["run"],
    "forget-unreachable": ["device", "forget-unreachable"],
};

// How the log of a detached run is followed (2026-10-20). Lines are read when the log changes (fs.watch), not on a
// timer. The run is no child of this process (on Windows it is not even the process spawned), so its end raises no
// event here: its pid is looked at every `aliveCheckMs`, the one timer left. Once it is gone the log is read on until it
// has been quiet for `drainQuietMs`, since `upgrade` replaces the binary then starts a new agent and the spawned pid can
// exit before its last lines are flushed; `drainMaxMs` (the fixed wait this used to be) caps that, since the new
// agent writes to the same log and it may never go quiet. `fallbackReadMs` re-reads whatever the watch says, for a
// file system where fs.watch is silent.
export interface LogFollowTiming {
    readonly aliveCheckMs: number;
    readonly drainQuietMs: number;
    readonly drainMaxMs: number;
    readonly fallbackReadMs: number;
    readonly timeoutMs: number;
}

const AGENT_LOG_TIMING: LogFollowTiming = { aliveCheckMs: 250, drainQuietMs: 300, drainMaxMs: 1_500, fallbackReadMs: 2_000, timeoutMs: 20 * 60 * 1000 };

// The timeout above is the ceiling on how long this streams for, far above a slow download: it only protects a reader
// whose device went quiet without closing the socket, the run itself finishes regardless.

// What is in the log now, from `from` on. Missing file means nothing yet; a log shorter than `from` was rotated
// (spawnDetached rotates a large one before it starts the run), so it is read from its start.
const readFrom = async (path: string, from: number): Promise<{ text: string; at: number }> => {
    const raw = (await readTextIfExists(path)) ?? "";
    return { text: raw.slice(raw.length < from ? 0 : from), at: raw.length };
};

export interface LogFollow {
    readonly path: string;
    readonly from: number;
    readonly isAlive: () => boolean;
    readonly onLine: (line: string) => void;
    readonly timing?: LogFollowTiming | undefined;
}

// Hands every new line of the log to `onLine` until the run is gone and its log has drained, or the timeout.
export const followLog = async ({ path, from, isAlive, onLine, timing = AGENT_LOG_TIMING }: LogFollow): Promise<void> => {
    let at = from;
    let lastLineAt = Date.now();
    let lastReadAt = 0;
    let running: Promise<void> | undefined;
    let again = false;
    const readOnce = async (): Promise<void> => {
        lastReadAt = Date.now();
        const { text, at: next } = await readFrom(path, at);
        at = next;
        const lines = text.split(/\r?\n/).filter((one) => one.trim() !== "");
        if (lines.length > 0) {
            lastLineAt = Date.now();
        }
        for (const line of lines) {
            onLine(line);
        }
    };
    // One read at a time; changes during it ask for one more, so a burst of writes costs two reads, not one per write.
    const drain = async (): Promise<void> => {
        if (running !== undefined) {
            again = true;
            return await running;
        }
        running = (async () => {
            do {
                again = false;
                await readOnce();
            } while (again);
        })().finally(() => {
            running = undefined;
        });
        return await running;
    };
    const unwatch = onFileChange(path, () => void drain());
    const startedAt = Date.now();
    let goneAt: number | undefined;
    try {
        await new Promise<void>((resolve) => {
            const look = async (): Promise<void> => {
                const now = Date.now();
                if (unwatch === undefined || now - lastReadAt >= timing.fallbackReadMs) {
                    await drain();
                }
                if (now - startedAt >= timing.timeoutMs) {
                    stop();
                    return;
                }
                if (isAlive()) {
                    return;
                }
                if (goneAt === undefined) {
                    goneAt = now;
                    await drain();
                }
                if (now - goneAt >= timing.drainMaxMs || Date.now() - Math.max(lastLineAt, goneAt) >= timing.drainQuietMs) {
                    stop();
                }
            };
            const tick = setInterval(() => void look(), timing.aliveCheckMs);
            const stop = (): void => {
                clearInterval(tick);
                resolve();
            };
        });
    } finally {
        unwatch?.();
        await drain();
    }
};

// Start it, then narrate it. The answer is about what was STARTED, not what it achieved, since this process is
// usually not alive to see the end; the reader confirms by the version moving. `onLine` is the same callback
// the sandbox flows take (see ../router.ts).
const started = (op: DeviceAgentOp, installed: string | undefined): string => {
    if (op === "upgrade") {
        return `Updating the agent on this whole machine, every WSL distro included${installed === undefined ? "" : ` (this side runs ${installed})`}. Each side's agent restarts, so this connection drops while that happens.`;
    }
    if (op === "restart") {
        return `Restarting this device's agent. This connection drops while that happens.`;
    }
    return `Dropping this device's links to sandboxes that have stopped answering. The agent closes them on its next pass; this connection stays up.`;
};

// What the reader is left with once the run is out of this process's hands. Never a claim about the outcome: the work is
// detached, and this connection usually dies before it ends.
const settled: Record<DeviceAgentOp, string> = {
    upgrade: `The update ran on this machine. Whether each side's new agent is the one serving shows in its version, which this view re-reads on its own.`,
    restart: `The agent was restarted on this device.`,
    "forget-unreachable": `The drop ran on this device. What it removed is in the lines above; this device's link count catches up within a few seconds.`,
};

// The ops that end in this agent restarting.
const RESTARTS: ReadonlySet<DeviceAgentOp> = new Set<DeviceAgentOp>(["upgrade", "restart"]);

// A swap this process is running, which the detached command cannot see (it asks ic about cutovers, in
// supervision.ts): the restart waits for it here, so this agent never stops under an ic it started.
const waitOutOwnSwaps = async (onLine: (line: string) => void): Promise<void> => {
    if (icSwapsInFlight.size === 0) {
        return;
    }
    onLine(`Waiting for ${[...icSwapsInFlight].join(", ")} to finish first: restarting this agent in the middle of a swap could leave that sandbox down.`);
    await pollUntil(() => icSwapsInFlight.size === 0, { intervalMs: 1_000, timeoutMs: SWAP_WAIT_MAX_MS });
};

export const runAgentOp = async (op: DeviceAgentOp, onLine: (line: string) => void): Promise<string> => {
    if (RESTARTS.has(op)) {
        await waitOutOwnSwaps(onLine);
    }
    onLine(started(op, installedBuild()));
    // Taken before the spawn: the log is append-only and long-lived, and a reader sees only this run's lines.
    const at = (await readFrom(agentLogPath, 0)).at;
    const argv = AGENT_VERB[op];
    const pid = await spawnDetached(agentLogPath, machineLauncher(), argv, { finishes: true });
    onLine(`Started ${argv.join(" ")} (pid ${pid}), detached from this connection so it finishes either way. Log: ${agentLogPath}`);
    await followLog({ path: agentLogPath, from: at, isAlive: () => isProcessAlive(pid), onLine });
    return settled[op];
};
