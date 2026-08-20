import { type ChildProcessByStdio, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { AcpAgentConfig } from "@intentic/sandbox-contract";
import { parseEnvBlock, splitCommand } from "../acp/acp-spawn.js";
import { DAEMON_OWNER, workloadStamp } from "../platform/leftovers.js";

/* The Pi RPC transport: spawn `<command> --mode rpc` and speak its strict-LF JSONL protocol over stdio.
 * Commands go down stdin one JSON object per line; every one carries a minted `id`, and the matching
 * `{type:"response", id}` line resolves it. Everything else on stdout is an EVENT, handed to the turn loop
 * unparsed beyond JSON, the mapping onto AgentEvent frames lives in pi-events.ts, not here.
 *
 * Framing is deliberately hand-rolled on `indexOf("\n")`: Pi's own protocol doc rules out generic line
 * readers (Node readline also splits on U+2028/U+2029, which are valid inside JSON strings), and the
 * StringDecoder keeps a multi-byte character split across chunks from corrupting a record. */

// One process serves one turn (sessions persist as files, so there is nothing to keep warm between turns,
// unlike ACP, whose sessions live inside the process). The stderr tail is folded into surfaced errors, the
// acp-spawn precedent: a bare "exited" without the reason is undebuggable.
const STDERR_TAIL = 2000;

export interface PiResponse {
    readonly success: boolean;
    readonly error?: string;
    readonly data?: unknown;
}

// A stdout line that is not a response: `{type: "agent_settled"}`, `{type: "message_update", …}`, ….
export type PiEvent = { readonly type: string } & Record<string, unknown>;

export interface PiProcessHandlers {
    readonly onEvent: (event: PiEvent) => void;
    // The process died, with the tail of what it said on the way down. Fired once.
    readonly onExit: (code: number | null) => void;
}

export interface PiProcess {
    // Send a correlated command and await its response line. Rejects only when the process is gone,
    // a refused command is an ordinary `{success: false}` response, never a throw.
    readonly request: (command: Record<string, unknown>) => Promise<PiResponse>;
    // Fire-and-forget write (extension_ui_response has no response line of its own).
    readonly send: (command: Record<string, unknown>) => void;
    readonly alive: () => boolean;
    readonly stderrTail: () => string;
    readonly kill: () => void;
}

// The seam tests inject through: production is spawnPiProcess below, a fixture is a scripted object.
export type PiSpawn = (config: AcpAgentConfig, cwd: string, handlers: PiProcessHandlers) => PiProcess;

// Split a stream into LF-terminated records, tolerating \r\n and multi-byte splits. Shared shape with Pi's
// own reference client.
const attachJsonlReader = (stream: Readable, onLine: (line: string) => void): void => {
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    stream.on("data", (chunk: Buffer | string) => {
        buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
        for (;;) {
            const newline = buffer.indexOf("\n");
            if (newline === -1) {
                break;
            }
            let line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            if (line.endsWith("\r")) {
                line = line.slice(0, -1);
            }
            if (line !== "") {
                onLine(line);
            }
        }
    });
};

// Build the production spawner for one sessions directory (created eagerly. Pi writes session files there,
// and a missing dir should fail here, at composition, not inside a turn).
export const piSpawner = (sessionDir: string): PiSpawn => {
    mkdirSync(sessionDir, { recursive: true });
    return (config, cwd, handlers) => {
        const [head, ...rest] = splitCommand(config.command);
        const proc: ChildProcessByStdio<Writable, Readable, Readable> = spawn(
            head as string,
            [...rest, "--mode", "rpc", "--session-dir", sessionDir],
            {
                cwd,
                // Daemon-owned, like the ACP pool it mirrors: kept warm across turns on purpose, so only a
                // previous daemon's copy is ever a leftover (platform/leftovers.ts).
                env: { ...process.env, ...parseEnvBlock(config.env), ...workloadStamp(DAEMON_OWNER) },
                stdio: ["pipe", "pipe", "pipe"],
            },
        );

        let stderr = "";
        proc.stderr.setEncoding("utf8");
        proc.stderr.on("data", (chunk: string) => {
            stderr = (stderr + chunk).slice(-STDERR_TAIL);
        });

        let dead = false;
        let nextId = 0;
        const pending = new Map<string, (response: PiResponse) => void>();

        proc.on("error", (error) => {
            // A command that isn't on PATH surfaces as a spawn error, not an exit, same terminal state.
            stderr = (stderr + String(error.message)).slice(-STDERR_TAIL);
            settleExit(null);
        });
        proc.on("exit", (code) => settleExit(code));

        let exitSettled = false;
        const settleExit = (code: number | null): void => {
            if (exitSettled) {
                return;
            }
            exitSettled = true;
            dead = true;
            const waiting = [...pending.values()];
            pending.clear();
            for (const resolve of waiting) {
                resolve({ success: false, error: "the pi process exited" });
            }
            handlers.onExit(code);
        };

        attachJsonlReader(proc.stdout, (line) => {
            let parsed: unknown;
            try {
                parsed = JSON.parse(line);
            } catch {
                return; // Not protocol output — Pi promises JSONL, so a stray line is noise, not a frame.
            }
            const record = parsed as { type?: unknown; id?: unknown } & Record<string, unknown>;
            if (record.type === "response") {
                const resolve = typeof record.id === "string" ? pending.get(record.id) : undefined;
                if (resolve !== undefined) {
                    pending.delete(record.id as string);
                    resolve({
                        success: record["success"] === true,
                        ...(typeof record["error"] === "string" ? { error: record["error"] } : {}),
                        ...("data" in record ? { data: record["data"] } : {}),
                    });
                }
                return;
            }
            if (typeof record.type === "string") {
                handlers.onEvent(record as PiEvent);
            }
        });

        const send = (command: Record<string, unknown>): void => {
            if (!dead) {
                proc.stdin.write(`${JSON.stringify(command)}\n`);
            }
        };

        return {
            request: (command) =>
                new Promise<PiResponse>((resolve) => {
                    if (dead) {
                        resolve({ success: false, error: "the pi process exited" });
                        return;
                    }
                    const id = `req-${++nextId}`;
                    pending.set(id, resolve);
                    send({ ...command, id });
                }),
            send,
            alive: () => !dead,
            stderrTail: () => stderr,
            kill: () => {
                dead = true;
                proc.kill();
            },
        };
    };
};
