import { type ChildProcessByStdio, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { ndJsonStream, type Stream } from "@agentclientprotocol/sdk";
import { DAEMON_OWNER, workloadStamp } from "../platform/leftovers.js";

/* Spawning an ACP agent subprocess: the capability's command split on whitespace (no shell quoting — the
 * config documents this), the pasted KEY=VALUE env block layered over the daemon's env, and stdio piped into
 * the SDK's ndjson Stream. Stderr is kept as a bounded tail folded into surfaced errors (the agent.ts
 * precedent — a bare "exited" without the reason is undebuggable). */

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

export const spawnAcpProcess = (command: string, env: Record<string, string>, cwd: string): AcpProcess => {
    const [bin, ...args] = splitCommand(command);
    if (bin === undefined || bin === "") {
        throw new Error("ACP agent command is empty");
    }
    const child = spawn(bin, args, {
        cwd,
        // Stamped as the DAEMON's rather than any one turn's, because that is what a pooled agent is: it
        // deliberately outlives the turn that warmed it (acp-connection.ts), so the in-life sweep must never
        // read one as abandoned. What the stamp is for here is the other half — a pool process from a previous
        // daemon that nothing adopts and no other signal can tell apart from a live one (platform/leftovers.ts).
        env: { ...process.env, ...env, ...workloadStamp(DAEMON_OWNER) },
        stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (data: Buffer) => {
        stderr = (stderr + data.toString()).slice(-STDERR_TAIL);
    });
    const stream = ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    return { child, stream, stderrTail: () => stderr };
};
