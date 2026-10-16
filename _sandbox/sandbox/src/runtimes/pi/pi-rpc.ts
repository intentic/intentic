import type { ChildProcessByStdio } from "node:child_process";
import { mkdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { whenAborted } from "@intentic/base/async";
import type { AcpAgentConfig } from "@intentic/sandbox-contract/schemas/capabilities";
import type { AgentTool } from "../../agent/tools/agent-tools.js";
import type { NamespaceEntryReference } from "../../workload/namespace-entry.js";
import { namespaceTargetOf, nsenterArgv } from "../../workload/namespace-entry.js";
import { opt } from "../../opt.js";
import { runCheck } from "../../workload/run-check.js";
import { parseEnvBlock, splitCommand } from "../acp/acp-spawn.js";
import { spawnAs } from "../../workload/workload-class.js";
import { DAEMON_OWNER, workloadStamp } from "../../seams/workload-stamp.js";
import { jsonLines, outputTail } from "../stdio/child-output.js";
import { createHookSocket, type HookEndpoint } from "../daemon-tools/hook-socket.js";
import { PI_EXTENSION_SOURCE, PI_TURN_ENV, type PiTurnFile } from "./pi-extension.js";
import { parseJsonOr } from "@intentic/base/json";

// Pi RPC transport: spawns `<command> --mode rpc` and speaks its strict-LF JSONL protocol over stdio. Commands carry a
// minted `id`; the matching `{type:"response", id}` line resolves it, everything else on stdout is an event handed
// unparsed to the turn loop (mapping lives in pi-events.ts). Records are split on LF alone (stdio/child-output.ts).
//
// Each turn's process is started with what the daemon decided for it (PiLaunch): its instructions as Pi's own system
// prompt flags (`--system-prompt` replaces Pi's base, `--append-system-prompt` adds to it) with `--no-context-files`,
// since the daemon composes AGENTS.md itself and Pi would load it a second time; its skills as `--skill` paths with
// Pi's own discovery off (`--no-skills`), so the persona's filter is the whole list; and the daemon's own extension
// (pi-extension.ts, `-e`), which gives Pi an ask tool, mounts the turn's MCP servers on a Pi that has built-in MCP, and
// puts every tool call and result to the turn's hook socket (pi-hooks.ts). `-e` loads it even where the card's command
// turns Pi's own extension discovery off (`--no-extensions`). Every file handed over is written to a per-turn directory the process can read at the same path (an anchored turn's
// handoff dir, inside its namespace too), and goes with the process.

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
    // Send a correlated command and await its response line. A refused command, or one sent to a process that is gone,
    // is an ordinary {success: false} response, never a throw. Rejects only when `signal` aborts, with its reason: the
    // wait ends and its id is forgotten, so an answer that comes later is dropped like any line nobody asked for. Pi has
    // no per-command cancel, so a command already written may still take effect on its side; one whose signal had
    // aborted before the call is never written.
    readonly request: (command: Record<string, unknown>, signal?: AbortSignal) => Promise<PiResponse>;
    // Fire-and-forget write (extension_ui_response has no response line of its own).
    readonly send: (command: Record<string, unknown>) => void;
    readonly alive: () => boolean;
    readonly stderrTail: () => string;
    readonly kill: () => void;
}

// What one turn starts its Pi with, beyond the installed card's command.
export interface PiLaunch {
    readonly cwd: string;
    // The conversation the turn runs for, stamped on the process so the reaper retires it and its tools like a Claude
    // turn's. Absent stays the daemon's.
    readonly owner?: string;
    readonly spawnDepth?: number;
    // The daemon's instructions (agent-request.ts systemPrompt/systemAppend): in place of Pi's base, or after it.
    readonly instructions?: { readonly replace?: string; readonly append?: string };
    // Skill folders, as the process sees them; Pi's own discovery is off, so this is the whole list.
    readonly skills?: readonly string[];
    // The turn's remote MCP servers (TurnTools.remote), mounted where Pi has built-in MCP.
    readonly tools?: readonly AgentTool[];
    // What the turn's hook socket answers (pi-hooks.ts): opened in the turn's directory before Pi starts and closed with
    // the process. Absent opens none, and the extension refuses every call it cannot ask about.
    readonly hooks?: Readonly<Record<string, HookEndpoint>>;
    // An anchored turn's namespace: Pi is entered into it, so its shell and edits see the worktree at /work.
    readonly anchor?: {
        readonly pid: number;
        readonly cwd: string;
        readonly namespace?: NamespaceEntryReference;
        // Where the daemon hands it files it must read at the same path (isolation.ts handoffDirOf).
        readonly handoff?: string;
    };
}

// What the process was started with, as far as the turn needs to say so.
export interface PiStarted {
    // `pi --version`, when it answered with one.
    readonly version?: string;
    // Whether the turn's MCP servers were handed to Pi: false on a Pi older than its built-in MCP.
    readonly mcpMounted: boolean;
}

// The seam tests inject through: production is piSpawner below, a fixture is a scripted object.
export type PiSpawn = (config: AcpAgentConfig, launch: PiLaunch, handlers: PiProcessHandlers) => (PiProcess & Partial<PiStarted>) | Promise<PiProcess & Partial<PiStarted>>;

// The first Pi with built-in MCP and `pi.registerMcpServer` (upstream 0.99).
const MCP_SINCE = [0, 99, 0] as const;

const VERSION = /(\d+)\.(\d+)\.(\d+)/;

// Whether `version` is at or past `floor`; an unreadable version is not.
export const versionAtLeast = (version: string | undefined, floor: readonly [number, number, number]): boolean => {
    const parts = version === undefined ? undefined : VERSION.exec(version)?.slice(1, 4).map(Number);
    if (parts === undefined) {
        return false;
    }
    for (const [index, part] of parts.entries()) {
        const least = floor[index] ?? 0;
        if (part !== least) {
            return part > least;
        }
    }
    return true;
};

// `<command> --version` under the card's environment, asked once per command line and environment for the life of the
// daemon: an install changes it only with an image rebuild, which restarts the daemon too.
const versionProbe = () => {
    const known = new Map<string, Promise<string | undefined>>();
    return (argv: readonly string[], env: Readonly<Record<string, string>>): Promise<string | undefined> => {
        const key = JSON.stringify([argv, env]);
        let probed = known.get(key);
        if (probed === undefined) {
            probed = runCheck({
                argv: [...argv, "--version"],
                env: { ...process.env, ...env },
                timeoutMs: 10_000,
                workload: { class: "command" },
                kind: "probe",
                captureBytes: 4_096,
            }).then(({ stdout, stderr }) => VERSION.exec(`${stdout}\n${stderr}`)?.[0]);
            known.set(key, probed);
        }
        return probed;
    };
};

const nonBlank = (text: string | undefined): string | undefined => (text === undefined || text.trim() === "" ? undefined : text);

// The flags one turn adds, naming the files it wrote into `dir`; `hooks` is the turn's socket, when it has one.
const turnFlags = async (
    dir: string,
    launch: PiLaunch,
    mcp: boolean,
    hooks: string | undefined,
): Promise<{ readonly args: string[]; readonly env: Record<string, string> }> => {
    const args = ["--no-context-files", "--no-skills"];
    // As files, which Pi reads when a flag's value names one: an instruction set runs to tens of kilobytes, past what
    // one argv entry may hold, and a file keeps it out of the process list.
    for (const [flag, text] of [
        ["--system-prompt", nonBlank(launch.instructions?.replace)],
        ["--append-system-prompt", nonBlank(launch.instructions?.append)],
    ] as const) {
        if (text !== undefined) {
            const file = join(dir, `${flag.slice(2)}.md`);
            await writeFile(file, text, { mode: 0o600 });
            args.push(flag, file);
        }
    }
    for (const skill of launch.skills ?? []) {
        args.push("--skill", skill);
    }
    const servers = mcp ? (launch.tools ?? []) : [];
    const turnFile: PiTurnFile = {
        mcp: servers.map((tool) => ({ name: tool.name, url: tool.url, ...opt("token", tool.token), ...opt("timeoutMs", tool.timeoutMs) })),
        ...opt("hooks", hooks),
    };
    await writeFile(join(dir, "turn.json"), JSON.stringify(turnFile), { mode: 0o600 });
    await writeFile(join(dir, "intentic-extension.ts"), PI_EXTENSION_SOURCE, { mode: 0o600 });
    args.push("-e", join(dir, "intentic-extension.ts"));
    return { args, env: { [PI_TURN_ENV]: join(dir, "turn.json") } };
};

// Where Pi keeps its login and settings, named outright for a process entered into a namespace: an agent domain's
// entrant gets a HOME of its own (namespace-entry.ts), where Pi would find no sign-in.
const piAgentDir = (): string => process.env["PI_CODING_AGENT_DIR"] ?? join(homedir(), ".pi", "agent");

// Starts one turn's Pi: the version asked, the turn's files written, the process spawned, entered into the turn's
// namespace when it is anchored, as Codex's app-server and Cursor's runtime are (nsenter execs it there and stays a
// direct child, its cwd /work as the namespace sees it). The turn's files go with the process.
const startPi = async (
    sessionDir: string,
    versionOf: ReturnType<typeof versionProbe>,
    config: AcpAgentConfig,
    launch: PiLaunch,
): Promise<{ readonly proc: ChildProcessByStdio<Writable, Readable, Readable> } & PiStarted> => {
    const [head = "pi", ...rest] = splitCommand(config.command);
    const cardEnv = parseEnvBlock(config.env);
    const version = await versionOf([head, ...rest], cardEnv);
    const mcpMounted = (launch.tools ?? []).length > 0 && versionAtLeast(version, MCP_SINCE);
    const dir = await mkdtemp(join(launch.anchor?.handoff ?? tmpdir(), "intentic-pi-"));
    // In the turn's directory, which an anchored turn's Pi reads at the same path; listening before Pi starts, so its
    // first call finds it, and closed with the process.
    const socket = launch.hooks === undefined ? undefined : createHookSocket(join(dir, "hooks.sock"), launch.hooks);
    try {
        await socket?.listen();
    } catch (error) {
        await rm(dir, { recursive: true, force: true });
        throw error;
    }
    const flags = await turnFlags(dir, launch, mcpMounted, socket === undefined ? undefined : join(dir, "hooks.sock"));
    const args = [...rest, "--mode", "rpc", "--session-dir", sessionDir, ...flags.args];
    const { anchor } = launch;
    const entry = anchor === undefined ? { command: head, args } : nsenterArgv(namespaceTargetOf(anchor), anchor.cwd, head, args);
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (anchor !== undefined) {
        env["PI_CODING_AGENT_DIR"] = piAgentDir();
    }
    // Ranked like the ACP agents, at the top of the spawn tree.
    const proc: ChildProcessByStdio<Writable, Readable, Readable> = spawnAs({ class: "agentRuntime", spawnDepth: launch.spawnDepth ?? 0 }, entry.command, entry.args, {
        // An entered process takes its directory from nsenter, inside the namespace.
        ...opt("cwd", anchor === undefined ? launch.cwd : undefined),
        // One process per turn, so it is the conversation's, as a Claude turn's CLI is: once the turn ends, whatever it
        // or its tools left running is the reaper's (2026-10-05; stamped `daemon` before, which nothing reaps while the
        // daemon runs). A spawn that names no conversation stays the daemon's.
        env: { ...env, ...cardEnv, ...flags.env, ...workloadStamp(launch.owner ?? DAEMON_OWNER) },
        stdio: ["pipe", "pipe", "pipe"],
    });
    proc.once("close", () => {
        void (async () => {
            await socket?.close();
            await rm(dir, { recursive: true, force: true });
        })();
    });
    return { proc, ...opt("version", version), mcpMounted };
};

// Builds the production spawner for one sessions directory, created eagerly: a missing dir should fail here, at
// composition, not inside a turn.
export const piSpawner = (sessionDir: string): PiSpawn => {
    mkdirSync(sessionDir, { recursive: true });
    const versionOf = versionProbe();
    return async (config, launch, handlers) => {
        const { proc, ...started } = await startPi(sessionDir, versionOf, config, launch);

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
            const parsed = parseJsonOr(line, undefined);
            if (parsed === undefined) {
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
            ...started,
            request: (command, signal) =>
                new Promise<PiResponse>((resolve, reject) => {
                    if (signal?.aborted === true) {
                        reject(signal.reason);
                        return;
                    }
                    if (dead) {
                        resolve({ success: false, error: "the pi process exited" });
                        return;
                    }
                    const id = `req-${++nextId}`;
                    // A request given up on takes its resolver with it, so `pending` holds only waits someone is still on;
                    // without this a timed-out one sat there for the life of the process.
                    const unwatch = whenAborted(signal, () => {
                        pending.delete(id);
                        reject(signal?.reason);
                    });
                    pending.set(id, (response) => {
                        unwatch();
                        resolve(response);
                    });
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
