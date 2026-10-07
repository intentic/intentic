import type { ChildProcessByStdio } from "node:child_process";
import { mkdirSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import type { AcpAgentConfig } from "@intentic/sandbox-contract";
import { parseEnvBlock, splitCommand } from "../acp/acp-spawn.js";
import { spawnAs } from "../../workload/workload-class.js";
import { DAEMON_OWNER, workloadStamp } from "../../seams/workload-stamp.js";
import { jsonLines, outputTail } from "../stdio/child-output.js";

// Pi RPC transport: spawns `<command> --mode rpc` and speaks its strict-LF JSONL protocol over stdio. Commands carry a
// minted `id`; the matching `{type:"response", id}` line resolves it, everything else on stdout is an event handed
// unparsed to the turn loop (mapping lives in pi-events.ts). Records are split on LF alone (stdio/child-output.ts).

// One process serves one turn, unlike ACP's warm sessions (Pi's persist as files). The stderr tail folds into surfaced
// errors (acp-spawn precedent): a bare "exited" is undebuggable.
const STDERR_TAIL = 2000;

export interface PiResponse {
    readonly success: boolean;
    readonly error?: string;
    readonly data?: unknown;
}

// A stdout line that is not a response: {type: "agent_settled"}, {type: "message_update", …}, ….
export type PiEvent = { readonly type: string } & Record<string, unknown>;

export interface PiProcessHandlers {
    readonly onEvent: (event: PiEvent) => void;
    // The process died, with the tail of what it said on the way down. Fired once.
    readonly onExit: (code: number | null) => void;
}

export interface PiProcess {
    // Send a correlated command and await its response line. Rejects only when the process is gone; a refused command
    // is an ordinary {success: false} response, never a throw.
    readonly request: (command: Record<string, unknown>) => Promise<PiResponse>;
    // Fire-and-forget write (extension_ui_response has no response line of its own).
    readonly send: (command: Record<string, unknown>) => void;
    readonly alive: () => boolean;
    readonly stderrTail: () => string;
    readonly kill: () => void;
}

// The seam tests inject through: production is spawnPiProcess below, a fixture is a scripted object. `owner` is the
// conversation the turn runs for, stamped on the process so the reaper retires it and its tools like a Claude turn's.
export type PiSpawn = (config: AcpAgentConfig, cwd: string, handlers: PiProcessHandlers, owner?: string) => PiProcess;

// Builds the production spawner for one sessions directory, created eagerly: a missing dir should fail here, at
// composition, not inside a turn.
export const piSpawner = (sessionDir: string): PiSpawn => {
    mkdirSync(sessionDir, { recursive: true });
    return (config, cwd, handlers, owner) => {
        const [head, ...rest] = splitCommand(config.command);
        // Ranked like the ACP agents, at the top of the spawn tree.
        const proc: ChildProcessByStdio<Writable, Readable, Readable> = spawnAs(
            { class: "agentRuntime", spawnDepth: 0 },
            head as string,
            [...rest, "--mode", "rpc", "--session-dir", sessionDir],
            {
                cwd,
                // One process per turn, so it is the conversation's, as a Claude turn's CLI is: once the turn ends,
                // whatever it or its tools left running is the reaper's (2026-10-05; stamped `daemon` before, which
                // nothing reaps while the daemon runs). A spawn that names no conversation stays the daemon's.
                env: { ...process.env, ...parseEnvBlock(config.env), ...workloadStamp(owner ?? DAEMON_OWNER) },
                stdio: ["pipe", "pipe", "pipe"],
            },
        );

        const stderr = outputTail(STDERR_TAIL);
        stderr.follow(proc.stderr);

        let dead = false;
        let nextId = 0;
        const pending = new Map<string, (response: PiResponse) => void>();

        proc.on("error", (error) => {
            // A command that isn't on PATH surfaces as a spawn error, not an exit, same terminal state.
            stderr.append(String(error.message));
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

        const onLine = (line: string): void => {
            let parsed: unknown;
            try {
                parsed = JSON.parse(line);
            } catch {
                return; // Not protocol output: Pi promises JSONL, so a stray line is noise, not a frame.
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
        };
        void (async () => {
            for await (const line of jsonLines(proc.stdout)) {
                onLine(line);
            }
        })().catch(() => {
            // A stdout that broke leaves no way to read a response; ending the process settles every waiter through
            // its exit.
            proc.kill();
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
            stderrTail: stderr.text,
            kill: () => {
                dead = true;
                proc.kill();
            },
        };
    };
};
