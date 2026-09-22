import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { isProcessAlive, spawnDetached } from "@intentic/local-agent";
import type { DeviceAgentOp, DeviceScopes } from "@intentic/sandbox-contract";
import { agentLogPath } from "../../config.js";
import { installedBuild } from "../../installed.js";
import { machineLauncher } from "../../supervision.js";
import { assertScope } from "../policy.js";

// Updates or restarts this device's own agent, asked for from the browser. Both operations stop the process
// serving this socket, so the work is detached (spawnDetached) and tailed back rather than spawned inline,
// which would die with an EPIPE mid-swap. Gated by "Run commands", not a sandbox switch: this touches no container.

// `intentic-machine <verb…>`; the op is a closed enum in the contract and this is the whole mapping. Every one is a TASK:
// it does its work and exits, often within spawnDetached's settle window, which must not read that as a crash.
export const AGENT_VERB: Record<DeviceAgentOp, readonly string[]> = {
    upgrade: ["upgrade"],
    restart: ["run"],
    "forget-unreachable": ["device", "forget-unreachable"],
};

// How long to keep reading the log after the detached run stops looking alive. `upgrade` replaces the binary
// then starts a new agent, so the spawned pid can exit before its last lines are flushed.
const DRAIN_MS = 1_500;
const POLL_MS = 250;

// The ceiling on how long this streams for, far above a slow download: it only protects a reader whose device
// went quiet without closing the socket, the run itself finishes regardless.
const WATCH_TIMEOUT_MS = 20 * 60 * 1000;

// What is in the log now, from `from` bytes on, as whole lines. Missing file means nothing yet.
const readFrom = async (path: string, from: number): Promise<{ text: string; at: number }> => {
    const raw = await readFile(path, "utf8").catch(() => "");
    return { text: raw.slice(from), at: raw.length };
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

export const runAgentOp = async (op: DeviceAgentOp, scopes: DeviceScopes, onLine: (line: string) => void): Promise<string> => {
    assertScope(scopes, "shell");
    onLine(started(op, installedBuild()));
    // Fresh watermark per run, taken before the spawn: the log is append-only and long-lived, so a reader must see
    // only this run's lines.
    const start = (await readFrom(agentLogPath, 0)).at;
    const argv = AGENT_VERB[op];
    const pid = await spawnDetached(agentLogPath, machineLauncher(), argv, { finishes: true });
    onLine(`Started ${argv.join(" ")} (pid ${pid}), detached from this connection so it finishes either way. Log: ${agentLogPath}`);

    let at = start;
    const deadline = Date.now() + WATCH_TIMEOUT_MS;
    let goneAt: number | undefined;
    while (Date.now() < deadline) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- a tail is serial by definition: read, emit, wait
        const { text, at: next } = await readFrom(agentLogPath, at);
        at = next;
        for (const line of text.split(/\r?\n/).filter((one) => one.trim() !== "")) {
            onLine(line);
        }
        if (!isProcessAlive(pid)) {
            goneAt ??= Date.now();
            if (Date.now() - goneAt > DRAIN_MS) {
                break;
            }
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- ditto
        await sleep(POLL_MS);
    }
    return settled[op];
};
