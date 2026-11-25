import type { ChildProcessByStdio } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { ndJsonStream, type Stream } from "@agentclientprotocol/sdk/unstable";
import type { AcpAgentConfig } from "@intentic/sandbox-contract/schemas/capabilities";
import type { DialectId } from "@intentic/acp-events/dialects";
import { spawnAs } from "../../workload/workload-class.js";
import { stopTree } from "../../workload/process-group.js";
import { DAEMON_OWNER, workloadStamp } from "../../seams/workload-stamp.js";
import { webStream } from "@intentic/base/web-stream";
import { outputTail } from "../stdio/child-output.js";

/* Spawning an ACP agent subprocess: the capability's command split on whitespace (no shell quoting, the config documents this). */

export const splitCommand = (command: string): string[] => command.trim().split(/\s+/);

// KEY=VALUE per line; blank lines and #-comments skipped. Values keep everything after the first "=".
export const parseEnvBlock = (block: string | undefined): Record<string, string> => {
    const env: Record<string, string> = {};
    for (const line of (block ?? "").split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "" || trimmed.startsWith("#")) {
            continue;
        }
        const eq = trimmed.indexOf("=");
        if (eq <= 0) {
            continue;
        }
        env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    return env;
};

const STDERR_TAIL = 2000;

export interface AcpProcess {
    readonly child: ChildProcessByStdio<NodeJS.WritableStream & Writable, NodeJS.ReadableStream & Readable, NodeJS.ReadableStream & Readable>;
    readonly stream: Stream;
    readonly stderrTail: () => string;
}

// What starts one agent process: its argv, run with no shell, and the variables laid over the daemon's own environment.
// An installed card's comes from its config (acpLaunchOf); a native provider on this runtime builds its own, so a
// resolved binary path is never re-split and a credential never round-trips through an env block.
export interface AcpLaunch {
    readonly argv: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    // Signs the process in over the protocol once it has answered initialize, so a credential reaches the agent without
    // an env var every command it runs would inherit. Sent with the first method the agent advertises.
    readonly authenticate?: { readonly meta: Readonly<Record<string, unknown>> };
    // Sent as `_meta` on every session/new and session/load, for an agent that reads per-session switches there (Grok
    // Build reads `askUserQuestion`, which the daemon no longer turns off since its dialect answers the tool). Part of
    // the process's identity like the rest, so a change respawns it.
    readonly sessionMeta?: AcpSessionMeta;
    // The agent's dialect (@intentic/acp-events dialects `dialectOf`): what it says beyond the protocol, read. Absent,
    // plain ACP.
    readonly dialect?: DialectId;
}

// Per-session switches, scalar values only: what an agent reads off session/new's `_meta` is a flag or a name.
export type AcpSessionMeta = Readonly<Record<string, string | number | boolean>>;

export const acpLaunchOf = (config: AcpAgentConfig): AcpLaunch => ({ argv: splitCommand(config.command), env: parseEnvBlock(config.env) });

export const spawnAcpProcess = (launch: AcpLaunch, cwd: string): AcpProcess => {
    const [bin, ...args] = launch.argv;
    if (bin === undefined || bin === "") {
        throw new Error("ACP agent command is empty");
    }
    // A runtime because this adapter started it, whatever its command (`npx some-agent`, `bun run agent`): pooled
    // across turns, so it ranks at the top of the spawn tree rather than any one turn's depth.
    const child = spawnAs({ class: "agentRuntime", spawnDepth: 0 }, bin, args, {
        cwd,
        // Stamped as the DAEMON's rather than any one turn's, because that is what a pooled agent is: it
        // deliberately outlives the turn that warmed it (acp-connection.ts), so the in-life sweep must never
        // read one as abandoned.
        env: { ...process.env, ...launch.env, ...workloadStamp(DAEMON_OWNER) },
        stdio: ["pipe", "pipe", "pipe"],
        // The leader of a process group of its own, so stopping it (stopAcpProcess) ends the whole tree: `npx`'s real
        // agent and the MCP servers that agent started, which a signal to the wrapper alone left running (2026-11-24).
        // Out of the daemon's group, so intentic-netd's group kill after a crash no longer reaches it: the next
        // daemon's boot sweep does (system/boot/generation-sweep.ts), by the earlier run's generation every process
        // of the tree inherited from the daemon's environment, ending the group it leads.
        detached: true,
    });
    const stderr = outputTail(STDERR_TAIL);
    stderr.follow(child.stderr);
    const stream = ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        webStream<Uint8Array>(Readable.toWeb(child.stdout)),
    );
    return { child, stream, stderrTail: stderr.text };
};

/** Stops an agent process and everything it started; also sweeps what a leader that exited on its own left behind. */
export const stopAcpProcess = (proc: AcpProcess, graceMs?: number): void => stopTree(proc.child, graceMs);
