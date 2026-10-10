import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import type { AgentEvent } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { type CommandGuard, consultWith, vendorSubject } from "../../guard/command-guard.js";
import { GATE_SCRIPT_NAME, gateScript, hooksJson, shieldedCommand, unshieldedCommand, wrappedCommand } from "./cursor-hook-script.js";

// Owner's command rulebook enforced inside Cursor's own loop via beforeShellExecution, the owner's standing
// instructions folded onto Cursor's base prompt via beforeSubmitPrompt, and the privacy shield's hand on every file read,
// tool call and edited file (preToolUse, beforeReadFile, afterFileEdit): the hook is a process this daemon wrote, so it
// can hold the answer while a card waits on a person, unlike a clocked vendor approval channel.
// Lives at /etc/cursor/hooks.json, the enterprise layer, not ~/.cursor or the workspace's own.

// Fixed by Cursor, not configurable; the one location no workspace or user can move. The env override is test-only: it
// points the suite at a temp dir instead of writing a real machine-global file.
const enterpriseHooksPath = (): string => process.env["INTENTIC_CURSOR_HOOKS_FILE"] ?? "/etc/cursor/hooks.json";

export interface CursorRead {
    readonly path: string;
    readonly content: string | undefined;
    readonly image: Buffer | undefined;
    readonly document?: Buffer | undefined;
    readonly opaque?: boolean;
}

// The privacy shield's side of one turn's hooks (cursor-shield.ts builds it), present while the shield reads the turn.
// Absent, every hook it answers lets the call through untouched.
export interface CursorHookShield {
    // A file Cursor's model opens with its own read tool, which can be refused but not changed: the sentence that
    // refuses it, or undefined to let it through. Cursor hands the hook a picture's or a PDF's content as "" and sends
    // the bytes, so the script reads them where the path means what Cursor meant: `image` is a picture's bytes,
    // `document` a PDF's, each empty when too large to read; `opaque` a file Cursor read whose bytes are neither (or
    // could not be looked at), which nothing here can check.
    readonly read: (file: CursorRead) => Promise<string | undefined>;
    // A tool call before it runs: refused with a sentence, run with its input changed (tokens read back to their
    // values), or run as it is. A shell command's wrapping is the service's, which alone knows the script it runs.
    readonly toolCall: (call: {
        readonly tool: string;
        readonly input: Record<string, unknown>;
        // What a whole-file write would replace, read where its path means what Cursor meant.
        readonly existing: string | undefined;
    }) => Promise<{ readonly refuse: string } | { readonly input: Record<string, unknown> | undefined }>;
    // What a shielded command printed, as the model may read it. Throws when it cannot be masked.
    readonly shellOutput: (output: string) => Promise<string>;
    // An edited file with the tokens in its new lines read back, or undefined when there is nothing to change.
    readonly edited: (content: string, edits: readonly { readonly old_string: string; readonly new_string: string }[]) => string | undefined;
}

// One live turn's hook context, registered for as long as the turn runs and looked up by the payload's id. `push` is
// this turn's own event sink, so a permission card lands in the right conversation.
export interface CursorGateTurn {
    // Cursor's id for this turn's agent; the correlation key the hook payload carries back.
    readonly conversationId: string;
    // Capability credentials and persona values for this turn, never the daemon's ambient env.
    readonly cliEnv?: Record<string, string>;
    // What the daemon adds to Cursor's own base prompt (AgentRequest.systemAppend): product guidance, the persona note,
    // the workspace's standing instructions. Cursor has no system seam, so it rides beforeSubmitPrompt's
    // additional_context instead, which is what `instructions: "append"` means on this runtime.
    readonly systemAppend?: string;
    readonly gate: CommandGuard;
    readonly push: (event: AgentEvent) => void;
    readonly shield?: CursorHookShield;
}

export interface CursorHookService {
    // Opens the socket and writes the hooks file and gate script; idempotent, called once at boot.
    readonly start: () => Promise<void>;
    // Registers a live turn and returns its retire function; always call retire in a finally, or a gone turn keeps
    // answering.
    readonly register: (turn: CursorGateTurn) => () => void;
    // Whether the gate is actually wired, so a turn can report honestly whether its rules are enforced.
    readonly ready: () => boolean;
    // Whether the hooks file in force names this daemon's script for every hook the privacy shield reads a turn
    // through (preToolUse, beforeReadFile, afterFileEdit). Read from disk each time: another daemon, or an older build,
    // can rewrite the file after boot, and a turn the shield reads must not start on hooks that let its reads past.
    readonly covers: () => Promise<boolean>;
    // The socket, the script naming it, and the hooks file naming the script: the three links invariant.ts re-reads,
    // since another daemon can overwrite any of them after ready.
    readonly paths: () => { readonly socket: string; readonly script: string; readonly hooks: string };
    readonly close: () => Promise<void>;
}

// Only the three fields this reads are named; the payload carries more (model, generation_id, workspace roots) and none
// of it changes the verdict.
interface GateRequest {
    readonly command?: unknown;
    readonly conversation_id?: unknown;
    readonly cwd?: unknown;
}

// Both hooks that answer from a turn's own state rather than from the rulebook; neither reads anything else it carries.
interface TurnScopedRequest {
    readonly conversation_id?: unknown;
}

// The privacy shield's hooks, each with what the script adds from its side of a mount namespace.
interface ReadRequest extends TurnScopedRequest {
    readonly file_path?: unknown;
    readonly content?: unknown;
    readonly image_base64?: unknown;
    readonly document_base64?: unknown;
    readonly opaque?: unknown;
}
interface ToolRequest extends TurnScopedRequest {
    readonly tool_name?: unknown;
    readonly tool_input?: unknown;
    readonly existing_content?: unknown;
}
interface ShellCommandRequest extends TurnScopedRequest {
    readonly id?: unknown;
}
interface ShellOutputRequest extends TurnScopedRequest {
    readonly output?: unknown;
}
interface EditedRequest extends TurnScopedRequest {
    readonly content?: unknown;
    readonly edits?: unknown;
}

// Said to the model in place of a shielded command's output when its turn is gone: it ran past the turn that started it.
const SHELL_OUTPUT_ORPHANED = "[Output withheld by the privacy shield: the turn that ran this command has ended.]\n";
const SHELL_OUTPUT_FAILED = "[Output withheld: the privacy shield could not mask it.]\n";
const SHELL_COMMAND_GONE = "[Not run: the privacy shield no longer holds this command; its turn has ended, or it already ran.]\n";

// A shielded command with its values, held for the script that runs it to fetch once (POST /shell-command). Never in
// what Cursor records: Cursor writes a hook's rewrite into the call's own arguments and echoes it to its servers in the
// shell's result. Dropped when fetched, when its turn retires, or after a day nobody ran it.
interface HeldCommand {
    readonly turn: string;
    readonly command: string;
    readonly cwd: string | undefined;
    readonly at: number;
}
const HELD_COMMAND_MS = 24 * 60 * 60 * 1000;
// Where Cursor starts a shielded command whose working directory held a token: one that exists, since the real one
// stays out of its arguments too; the script then runs the command in the real one.
const NEUTRAL_CWD = "/";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const editsOf = (value: unknown): { old_string: string; new_string: string }[] =>
    Array.isArray(value)
        ? value.flatMap((edit) =>
              isRecord(edit) && typeof edit["new_string"] === "string"
                  ? [{ old_string: typeof edit["old_string"] === "string" ? edit["old_string"] : "", new_string: edit["new_string"] }]
                  : [],
          )
        : [];

const asString = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

// The hooks the privacy shield reads a Cursor turn through; each must name this daemon's script for a shielded turn to run.
const SHIELD_HOOKS = ["preToolUse", "beforeReadFile", "afterFileEdit"] as const;

const ENDPOINTS: ReadonlySet<string> = new Set(["/gate", "/session-env", "/prompt", "/read", "/pre-tool", "/shell-command", "/shell-output", "/edited"]);

export const createCursorHookService = (socketDir: string, logger: Logger): CursorHookService => {
    const socketPath = join(socketDir, "command-guard.sock");
    const scriptPath = join(socketDir, GATE_SCRIPT_NAME);
    const turns = new Map<string, CursorGateTurn>();
    const held = new Map<string, HeldCommand>();
    let server: Server | undefined;
    const hold = (command: HeldCommand): string => {
        for (const [id, each] of held) {
            if (command.at - each.at > HELD_COMMAND_MS) {
                held.delete(id);
            }
        }
        const id = randomUUID();
        held.set(id, command);
        return id;
    };

    // With exactly one live turn, an unlabelled consult can only be from it. With two or more, there's nothing to
    // reason from, so it allows and logs: a wrong card in the wrong conversation is worse than an unenforced, logged
    // command.
    const turnFor = (conversationId: string | undefined): CursorGateTurn | undefined => {
        if (conversationId !== undefined) {
            const exact = turns.get(conversationId);
            if (exact !== undefined) {
                return exact;
            }
        }
        if (turns.size === 1) {
            return [...turns.values()][0];
        }
        if (turns.size > 1) {
            logger.warn({ conversationId, live: turns.size }, "cursor: command gate could not tell which turn is asking, allowing");
        }
        return undefined;
    };

    const verdictFor = async (payload: GateRequest): Promise<{ permission: "allow" | "deny"; agent_message?: string; user_message?: string }> => {
        // preToolUse runs first and may have wrapped the command for the shield: the rules read the command that will
        // run, with its values, which the daemon holds by the wrapper's id.
        const raw = asString(payload.command);
        const wrapped = raw === undefined ? undefined : wrappedCommand(raw);
        const holding = wrapped === undefined ? undefined : held.get(wrapped.id);
        const command = wrapped === undefined ? raw : (holding?.command ?? wrapped.shown);
        const turn = turnFor(asString(payload.conversation_id));
        if (command === undefined || turn === undefined) {
            return { permission: "allow" };
        }
        // Same short-circuit other vendor-gated runtimes take: no rules or taint costs nothing, not even classifying.
        if (!turn.gate.enforcing) {
            return { permission: "allow" };
        }
        // Named for Cursor's own tool, so the card, transcript and runtime all agree on what ran. The shell's own cwd
        // places an install the way Claude Code's hook input does.
        const outcome = await consultWith(turn.gate, command, vendorSubject("Shell"), turn.push, { cwd: holding?.cwd ?? asString(payload.cwd) });
        if (outcome.allow) {
            // What the gate had to say about an allowed command (where an install writes) goes to the agent alone.
            return outcome.context === undefined ? { permission: "allow" } : { permission: "allow", agent_message: outcome.context };
        }
        // Same sentence for both fields: the gate already phrases the refusal; splitting would mean writing it twice.
        return { permission: "deny", agent_message: outcome.reason, user_message: outcome.reason };
    };

    // Never uses the gate's single-live-turn fallback: a sessionStart hook can come from an owner's own hand-run Cursor
    // process, and handing it a turn's environment would cross the capability boundary. No exact id, no environment.
    const environmentFor = (payload: TurnScopedRequest): { env: Record<string, string> } => {
        const conversationId = asString(payload.conversation_id);
        if (conversationId === undefined) {
            return { env: {} };
        }
        return { env: turns.get(conversationId)?.cliEnv ?? {} };
    };

    // Exact id only, for the same reason as the environment above: the append carries the workspace's own standing
    // instructions and the persona this turn acts as, neither of which belongs in a Cursor process this daemon didn't
    // start. An empty append is omitted rather than sent blank, so Cursor's own prompt is left exactly as it was.
    // `continue` is stated rather than left unset: false is how this hook family blocks a prompt outright, and no
    // answer of ours ever means that.
    const instructionsFor = (payload: TurnScopedRequest): { continue: true; additional_context?: string } => {
        const conversationId = asString(payload.conversation_id);
        const append = conversationId === undefined ? undefined : turns.get(conversationId)?.systemAppend;
        return append === undefined || append === "" ? { continue: true } : { continue: true, additional_context: append };
    };

    // The turn a shield hook speaks for, found as the gate finds its turn, since a privacy check that names the wrong
    // turn errs toward checking. With several turns live and none named, any one the shield reads stands in, so a call
    // nothing can place is checked rather than waved through; `key` is the turn's own id, for the shell wrapper.
    const shieldedTurnFor = (conversationId: string | undefined): { key: string; shield: CursorHookShield } | undefined => {
        const turn = turnFor(conversationId);
        if (turn !== undefined) {
            return turn.shield === undefined ? undefined : { key: turn.conversationId, shield: turn.shield };
        }
        const any = [...turns.values()].find((each) => each.shield !== undefined);
        return any?.shield === undefined ? undefined : { key: any.conversationId, shield: any.shield };
    };

    const readVerdictFor = async (payload: ReadRequest): Promise<{ permission: "allow" | "deny"; user_message?: string }> => {
        const turn = shieldedTurnFor(asString(payload.conversation_id));
        const path = asString(payload.file_path);
        if (turn === undefined || path === undefined) {
            return { permission: "allow" };
        }
        const bytes = (field: unknown): Buffer | undefined => (typeof field === "string" ? Buffer.from(field, "base64") : undefined);
        const refusal = await turn.shield.read({
            path,
            content: typeof payload.content === "string" ? payload.content : undefined,
            image: bytes(payload.image_base64),
            document: bytes(payload.document_base64),
            opaque: payload.opaque === true,
        });
        return refusal === undefined ? { permission: "allow" } : { permission: "deny", user_message: refusal };
    };

    // A tool call on its way: refused, changed, or left alone; a shell command the shield reads is wrapped so the
    // script runs it and its output is masked before Cursor reads it.
    const toolVerdictFor = async (payload: ToolRequest): Promise<Record<string, unknown>> => {
        const turn = shieldedTurnFor(asString(payload.conversation_id));
        const tool = asString(payload.tool_name);
        if (turn === undefined || tool === undefined || !isRecord(payload.tool_input)) {
            return {};
        }
        const verdict = await turn.shield.toolCall({
            tool,
            input: payload.tool_input,
            existing: typeof payload.existing_content === "string" ? payload.existing_content : undefined,
        });
        if ("refuse" in verdict) {
            return { permission: "deny", user_message: verdict.refuse, agent_message: verdict.refuse };
        }
        const input = verdict.input ?? payload.tool_input;
        const command = input["command"];
        if (tool === "Shell" && typeof command === "string" && command !== "") {
            // Cursor's arguments keep the command as the model wrote it, inside a wrapper naming the held one; a
            // working directory whose token was read back stays out of them too.
            const shown = typeof payload.tool_input["command"] === "string" ? unshieldedCommand(payload.tool_input["command"]) : "";
            const cwd = typeof input["cwd"] === "string" && input["cwd"] !== payload.tool_input["cwd"] ? input["cwd"] : undefined;
            const id = hold({ turn: turn.key, command: unshieldedCommand(command), cwd, at: Date.now() });
            return {
                updated_input: {
                    ...payload.tool_input,
                    ...(cwd === undefined ? {} : { cwd: NEUTRAL_CWD }),
                    command: shieldedCommand(scriptPath, turn.key, id, shown),
                },
            };
        }
        return verdict.input === undefined ? {} : { updated_input: verdict.input };
    };

    // Exact turn and id only, and once: the script that runs a wrapped command takes it from here.
    const shellCommandFor = (payload: ShellCommandRequest): { command: string; cwd?: string } | { refused: string } => {
        const id = asString(payload.id);
        const command = id === undefined ? undefined : held.get(id);
        if (id === undefined || command === undefined || command.turn !== asString(payload.conversation_id) || !turns.has(command.turn)) {
            return { refused: SHELL_COMMAND_GONE };
        }
        held.delete(id);
        return command.cwd === undefined ? { command: command.command } : { command: command.command, cwd: command.cwd };
    };

    // Exact id only: the wrapper names the turn it was made for, and output that outlived its turn is withheld.
    const shellOutputFor = async (payload: ShellOutputRequest): Promise<{ output: string }> => {
        const conversationId = asString(payload.conversation_id);
        const output = typeof payload.output === "string" ? payload.output : "";
        const shield = conversationId === undefined ? undefined : turns.get(conversationId)?.shield;
        if (shield === undefined) {
            return { output: SHELL_OUTPUT_ORPHANED };
        }
        return { output: await shield.shellOutput(output) };
    };

    const editedFor = (payload: EditedRequest): { content?: string } => {
        const turn = shieldedTurnFor(asString(payload.conversation_id));
        if (turn === undefined || typeof payload.content !== "string") {
            return {};
        }
        const restored = turn.shield.edited(payload.content, editsOf(payload.edits));
        return restored === undefined ? {} : { content: restored };
    };

    return {
        start: async () => {
            if (server !== undefined) {
                return;
            }
            await mkdir(socketDir, { recursive: true });
            // An unclean shutdown can leave the socket behind, failing listen() forever; nothing else owns this path.
            await rm(socketPath, { force: true });
            const created = createServer((request, response) => {
                // Lets invariant.ts's probe tell this daemon's socket from one a second daemon has since re-bound.
                if (request.url === "/identity") {
                    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ pid: process.pid }));
                    return;
                }
                const endpoint = request.method === "POST" ? request.url : undefined;
                if (endpoint === undefined || !ENDPOINTS.has(endpoint)) {
                    response.writeHead(405).end();
                    return;
                }
                const answer = (body: unknown): void => {
                    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
                };
                const chunks: Buffer[] = [];
                request.on("data", (chunk: Buffer) => chunks.push(chunk));
                request.on("end", () => {
                    void (async () => {
                        let payload: GateRequest | TurnScopedRequest;
                        try {
                            payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as GateRequest | TurnScopedRequest;
                        } catch {
                            // The same harmless verdict the script writes when it can't reach this socket at all.
                            answer(endpoint === "/gate" || endpoint === "/read" ? { permission: "allow" } : endpoint === "/prompt" ? { continue: true } : {});
                            return;
                        }
                        if (endpoint === "/session-env") {
                            answer(environmentFor(payload as TurnScopedRequest));
                            return;
                        }
                        if (endpoint === "/prompt") {
                            answer(instructionsFor(payload as TurnScopedRequest));
                            return;
                        }
                        // The shield's own: each fails closed when the shield itself fails, since a read or an output
                        // that could not be checked is exactly what must not reach the model.
                        if (endpoint === "/read") {
                            answer(
                                await readVerdictFor(payload as ReadRequest).catch((error: unknown) => {
                                    logger.error({ err: error }, "cursor: the privacy shield could not check a file read, refusing it");
                                    return { permission: "deny" as const, user_message: `The privacy shield could not check this file (${errorMessage(error)}), so it was not read.` };
                                }),
                            );
                            return;
                        }
                        if (endpoint === "/pre-tool") {
                            answer(
                                await toolVerdictFor(payload as ToolRequest).catch((error: unknown) => {
                                    logger.error({ err: error }, "cursor: the privacy shield could not check a tool call, refusing it");
                                    const reason = `The privacy shield could not check this tool call (${errorMessage(error)}), so it did not run.`;
                                    return { permission: "deny", user_message: reason, agent_message: reason };
                                }),
                            );
                            return;
                        }
                        if (endpoint === "/shell-command") {
                            answer(shellCommandFor(payload as ShellCommandRequest));
                            return;
                        }
                        if (endpoint === "/shell-output") {
                            answer(
                                await shellOutputFor(payload as ShellOutputRequest).catch((error: unknown) => {
                                    logger.error({ err: error }, "cursor: the privacy shield could not mask a command's output, withholding it");
                                    return { output: SHELL_OUTPUT_FAILED };
                                }),
                            );
                            return;
                        }
                        if (endpoint === "/edited") {
                            answer(editedFor(payload as EditedRequest));
                            return;
                        }
                        // A gate that failed refuses at once, as the hook's failClosed does for a script that never answered.
                        const verdict = await verdictFor(payload as GateRequest).catch((error: unknown) => {
                            logger.error({ err: error }, "cursor: command gate failed, refusing the command");
                            const reason = `The command guard failed (${errorMessage(error)}), so this command was refused. Do not retry it: say plainly what you could not run.`;
                            return { permission: "deny" as const, agent_message: reason, user_message: reason };
                        });
                        answer(verdict);
                    })();
                });
            });
            await new Promise<void>((settle, fail) => {
                created.once("error", fail);
                created.listen(socketPath, () => {
                    created.removeListener("error", fail);
                    settle();
                });
            });
            // Owner-only: anything that can write to this socket can allow a command the owner's rules would deny.
            await chmod(socketPath, 0o600);
            server = created;

            await writeFile(scriptPath, gateScript(socketPath), { mode: 0o755 });
            // Best-effort: a container without /etc access is real; answer is unenforced rules, not refusing to boot.
            const hooksPath = enterpriseHooksPath();
            await mkdir(dirname(hooksPath), { recursive: true })
                .then(() => writeFile(hooksPath, hooksJson(scriptPath), { mode: 0o644 }))
                .catch((error: unknown) => {
                    logger.warn({ err: error, path: hooksPath }, "cursor: could not install the command-guard hook, rules will not apply");
                });
        },
        register: (turn) => {
            turns.set(turn.conversationId, turn);
            return () => {
                if (turns.get(turn.conversationId) === turn) {
                    turns.delete(turn.conversationId);
                    for (const [id, command] of held) {
                        if (command.turn === turn.conversationId) {
                            held.delete(id);
                        }
                    }
                }
            };
        },
        ready: () => server !== undefined,
        covers: async () => {
            if (server === undefined) {
                return false;
            }
            try {
                const installed = JSON.parse(await readFile(enterpriseHooksPath(), "utf8")) as { hooks?: Record<string, { command?: unknown }[] | undefined> };
                return SHIELD_HOOKS.every((hook) => (installed.hooks?.[hook] ?? []).some((entry) => typeof entry.command === "string" && entry.command.includes(scriptPath)));
            } catch {
                // allow(silent-catch): an absent or unreadable hooks file installs none of the shield's hooks, which is the answer.
                return false;
            }
        },
        paths: () => ({ socket: socketPath, script: scriptPath, hooks: enterpriseHooksPath() }),
        close: async () => {
            const running = server;
            server = undefined;
            turns.clear();
            if (running !== undefined) {
                await new Promise<void>((settle) => running.close(() => settle()));
            }
            await rm(socketPath, { force: true });
        },
    };
};
