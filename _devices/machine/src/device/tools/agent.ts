import { pollUntil } from "@intentic/base/async";
import { isProcessAlive, spawnDetached } from "@intentic/local-agent";
import type { DeviceAgentFlow, DeviceAgentOp } from "@intentic/sandbox-contract/schemas/devices";
import { agentLogPath } from "../../config.js";
import { installedBuild } from "../../installed.js";
import { forgetPowerReading } from "../../power/host-power.js";
import { fitReason } from "../../environments/wsl-memory-fit.js";
import { rereadWslMemory, wslMemoryFacts } from "../../environments/wsl-memory-watch.js";
import { machineLauncher } from "../../resident/supervision.js";
import { SWAP_WAIT_MAX_MS } from "../sandbox-rounds/swap-records.js";
import { onFileChange } from "./programs/file-changes.js";
import { agentLogReader, logSize } from "./logs/agent-log.js";
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
    // (2026-11-22) The owner's yes on the sandbox's host-power card: this computer's power plans changed so it stays on
    // while plugged in (power/apply.ts). No restart: the agent keeps serving.
    "power-stay-on": ["power", "stay-on"],
    // (2026-11-26) The owner's yes on the sandbox's wsl-memory card: memory= in this PC's .wslconfig set to the size they
    // approved (environments/wslconfig-memory.ts), which agentArgv adds. Nothing restarts: WSL takes it at its next start.
    "wsl-memory": ["wsl-memory", "apply"],
};

// Why the line .wslconfig gets says what it does: what this agent measured, where it still holds the finding the card
// came from, else the finding's gist.
const wslMemoryWhy = (): string => {
    const fit = wslMemoryFacts()?.fit;
    return fit === undefined ? "Windows sat under its low line for hours while the WSL VM held its memory" : fitReason(fit);
};

/** The argv of a flow: the op's verb, and for `wsl-memory` the size approved and why. */
export const agentArgv = (flow: DeviceAgentFlow, why: () => string = wslMemoryWhy): readonly string[] => {
    const verb = AGENT_VERB[flow.op];
    if (flow.op !== "wsl-memory") {
        return verb;
    }
    if (flow.memoryGb === undefined) {
        throw new Error("The wsl-memory op needs the size approved (memoryGb), and none came with it: nothing was changed.");
    }
    return [...verb, "--gb", String(flow.memoryGb), "--why", why()];
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

export interface LogFollow {
    readonly path: string;
    readonly from: number;
    readonly isAlive: () => boolean;
    readonly onLine: (line: string) => void;
    readonly timing?: LogFollowTiming | undefined;
}

// Hands every new line of the log to `onLine` until the run is gone and its log has drained, or the timeout. Timed on
// the monotonic clock: a wall clock moved under it (a test's fake time, an NTP step) would end the drain early or late.
export const followLog = async ({ path, from, isAlive, onLine, timing = AGENT_LOG_TIMING }: LogFollow): Promise<void> => {
    let lastLineAt = performance.now();
    // Never read yet: the first look reads whatever landed before the follow began.
    let lastReadAt = Number.NEGATIVE_INFINITY;
    let running: Promise<void> | undefined;
    let again = false;
    let stopped = false;
    const reader = agentLogReader(path, from, onLine);
    const readOnce = async (): Promise<void> => {
        lastReadAt = performance.now();
        if ((await reader.read()) > 0) {
            lastLineAt = performance.now();
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
                if (stopped) {
                    break;
                }
            } while (again);
        })().finally(() => {
            running = undefined;
        });
        return await running;
    };
    let unwatch: (() => void) | undefined;
    let tick: NodeJS.Timeout | undefined;
    const startedAt = performance.now();
    let goneAt: number | undefined;
    try {
        await new Promise<void>((resolve, reject) => {
            const stop = (): void => {
                stopped = true;
                clearInterval(tick);
                resolve();
            };
            unwatch = onFileChange(path, () => {
                if (!stopped) {
                    void drain().catch(reject);
                }
            });
            const look = async (): Promise<void> => {
                const now = performance.now();
                if (unwatch === undefined || now - lastReadAt >= timing.fallbackReadMs) {
                    await drain();
                }
                if (stopped) {
                    return;
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
                if (now - goneAt >= timing.drainMaxMs || performance.now() - Math.max(lastLineAt, goneAt) >= timing.drainQuietMs) {
                    stop();
                }
            };
            tick = setInterval(() => void look().catch(reject), timing.aliveCheckMs);
        });
    } finally {
        stopped = true;
        unwatch?.();
        clearInterval(tick);
    }
    await drain();
    reader.end();
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
    if (op === "power-stay-on") {
        return `Changing this computer's power settings so it stays on while plugged in: no sleep, hibernate or lid action on mains power. Battery settings are left as they are; this connection stays up.`;
    }
    if (op === "wsl-memory") {
        return `Setting memory= in this PC's .wslconfig, with the file as it was kept beside it. Nothing restarts: this connection stays up.`;
    }
    return `Dropping this device's links to sandboxes that have stopped answering. The agent closes them on its next pass; this connection stays up.`;
};

// What the reader is left with once the run is out of this process's hands and ended without a stop (runStop). Never a
// claim that it landed: the work is detached, and this connection usually dies before it ends.
const settled: Record<DeviceAgentOp, string> = {
    upgrade: `The update ran on this machine. Whether each side's new agent is the one serving shows in its version, which this view re-reads on its own.`,
    restart: `The agent was restarted on this device.`,
    "forget-unreachable": `The drop ran on this device. What it removed is in the lines above; this device's link count catches up within a few seconds.`,
    "power-stay-on": `This computer's power settings were changed: on mains power it no longer sleeps or hibernates by itself, and what each finding became is in the lines above. \`intentic-machine power restore\` on it puts the old values back.`,
    "wsl-memory": `memory= in this PC's .wslconfig was set, the file as it was kept beside it (the lines above name it). The WSL VM takes the new size only when WSL restarts (wsl --shutdown), which restarts every sandbox on this PC, this one included: that is the owner's to do.`,
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

// How the detached run ended, read from its own lines: a run that stops says so as `error: <headline>` with its indented
// `problem:`/`fix:` lines after it (cli-ui.ts failRun, plain mode, since its stderr is this log). The last stop is the
// run's; undefined when it ended without one. (2026-10-21) An update whose launcher swap was refused with EPERM still
// answered the settled sentence below, so the page said "Update finished" over the error that stopped it.
export const runStop = (lines: readonly string[]): string | undefined => {
    const at = lines.findLastIndex((line) => line.startsWith("error: "));
    if (at === -1) {
        return undefined;
    }
    const rest = lines.slice(at + 1);
    const end = rest.findIndex((line) => !/^\s/u.test(line));
    return [(lines[at] ?? "").slice("error: ".length), ...(end === -1 ? rest : rest.slice(0, end))].join("\n");
};

export const runAgentOp = async (op: DeviceAgentOp, onLine: (line: string) => void, flow: Pick<DeviceAgentFlow, "memoryGb"> = {}): Promise<string> => {
    if (RESTARTS.has(op)) {
        await waitOutOwnSwaps(onLine);
    }
    onLine(started(op, installedBuild()));
    // Taken before the spawn: the log is append-only and long-lived, and a reader sees only this run's lines.
    const at = await logSize(agentLogPath);
    const argv = agentArgv({ ...flow, op });
    const pid = await spawnDetached(agentLogPath, machineLauncher(), argv, { finishes: true });
    onLine(`Started ${argv.join(" ")} (pid ${pid}), detached from this connection so it finishes either way. Log: ${agentLogPath}`);
    const lines: string[] = [];
    try {
        await followLog({
            path: agentLogPath,
            from: at,
            isAlive: () => isProcessAlive(pid),
            onLine: (line) => {
                lines.push(line);
                onLine(line);
            },
        });
    } finally {
        // The facts this agent answers read the settings again, rather than keep the reading from before the change.
        if (op === "power-stay-on") {
            forgetPowerReading();
        }
        if (op === "wsl-memory") {
            await rereadWslMemory();
        }
    }
    const stop = runStop(lines);
    if (stop !== undefined) {
        throw new Error(stop);
    }
    return settled[op];
};
