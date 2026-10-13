import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import { isRecord } from "@intentic/base/escape";
import type { JsonValue } from "@intentic/base/fetch-json";
import type { AgentEvent } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { z } from "zod";
import type { CommandGuard } from "../../guard/command-guard.js";
import { opt } from "../../opt.js";
import { createHookSocket, type HookAnswer, type HookEndpoint } from "../daemon-tools/hook-socket.js";
import { consultPolicy, createPolicyGate, guardFailed, type PolicyGate, type PolicyTurn } from "../daemon-tools/policy-gate.js";
import { AskFieldsSchema, builtInAsk, type CursorOwner, mcpAsk } from "./turn/cursor-approvals.js";
import { GATE_SCRIPT_NAME, gateScript, hooksJson, LIVE_TURNS_NAME, shieldedCommand, unshieldedCommand, wrappedCommand } from "./cursor-hook-script.js";
import { type CursorSecrets, secretReadRefusal, secretWriteRefusal } from "./turn/cursor-secrets.js";
import { type CursorTerminal, paneCommand } from "./turn/cursor-terminal.js";
import { CUSTOM_TOOLS_SERVER, hookToolRefusal, mcpToolRefusal } from "./turn/cursor-tool-list.js";

// Owner's command rulebook enforced inside Cursor's own loop via beforeShellExecution, the owner's standing
// instructions folded onto Cursor's base prompt via beforeSubmitPrompt, the turn's tool list and per-tool cards on every
// call Cursor's own executors run (preToolUse, beforeMCPExecution), every shell command run through the hook script so
// its secrets resolve and its output is masked (and it shows in the terminal panel), and the privacy shield's hand on
// every file read, tool call and edited file (preToolUse, beforeReadFile, afterFileEdit): the hook is a process this
// daemon wrote, so it can hold the answer while a card waits on a person, unlike a clocked vendor approval channel.
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

// A tool call's input as the shield reads and rewrites it.
type CursorHookToolInput = Parameters<CursorHookShield["toolCall"]>[0]["input"];

// One live turn's hook context, registered for as long as the turn runs and looked up by the payload's id. `push` is
// this turn's own event sink, so a permission card lands in the right conversation.
export interface CursorGateTurn {
    // Cursor's id for this turn's agent; the correlation key the hook payload carries back.
    readonly conversationId: string;
    // Capability credentials and persona values for this turn, never the daemon's ambient env.
    readonly cliEnv?: Record<string, string>;
    // What the daemon adds to Cursor's own base prompt (AgentRequest.systemAppend): product guidance, the persona note,
    // the workspace's standing instructions. It rides beforeSubmitPrompt's additional_context, the seam every account
    // reaches; the owner's replacement prompt goes to AgentOptions.systemPrompt instead where the account is entitled to
    // replace the base, and folds in here where it is not (cursor-agent.ts).
    readonly systemAppend?: string;
    readonly gate: CommandGuard;
    readonly push: (event: AgentEvent) => void;
    readonly shield?: CursorHookShield;
    // The turn's tool list in Claude's names (TurnPolicy.allowedTools), checked on every call a hook sees
    // (cursor-tool-list.ts); absent, nothing is checked against a list.
    readonly allowedTools?: readonly string[] | undefined;
    // The sandbox's stored secrets as this turn reaches them: resolved into a command once it may run, masked out of
    // what it prints, and a file holding one kept from the read tool (cursor-secrets.ts).
    readonly secrets?: CursorSecrets | undefined;
    // Where the turn's shell runs visibly (cursor-terminal.ts); absent, a command runs as the script's own child.
    readonly terminal?: CursorTerminal | undefined;
    // The person a `default`-mode turn puts each call to (cursor-approvals.ts); absent in every other mode.
    readonly owner?: CursorOwner | undefined;
    // Skills the persona or a credential gate withholds from this turn: the read tool refuses their files, the seam the
    // Claude Code loop's `Skill(<name>)` denial stands in (cursor-skills.ts).
    readonly deniedSkills?: readonly string[] | undefined;
}

export interface CursorHookService {
    // Opens the socket and writes the hooks file and gate script; idempotent, called once at boot.
    readonly start: () => Promise<void>;
    // Registers a live turn and returns its retire function; always call retire in a finally, or a gone turn keeps
    // answering.
    readonly register: (turn: CursorGateTurn) => () => void;
    // Whether the gate is actually wired, so a turn can report honestly whether its rules are enforced.
    readonly ready: () => boolean;
    // Whether the hooks file in force names this daemon's script for every hook in `hooks` (by default the ones the
    // privacy shield reads a turn through). Read from disk each time: another daemon, or an older build, can rewrite the
    // file after boot, and a turn the shield reads, or one held to a tool list, must not start on hooks that let calls past.
    readonly covers: (hooks?: readonly CursorHookName[]) => Promise<boolean>;
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
    readonly aimed?: unknown;
}
interface McpRequest extends TurnScopedRequest {
    readonly tool_name?: unknown;
    readonly mcp_server_name?: unknown;
}
interface EditedRequest extends TurnScopedRequest {
    readonly content?: unknown;
    readonly edits?: unknown;
}

// Said to the model in place of a shielded command's output when its turn is gone: it ran past the turn that started it.
const SHELL_OUTPUT_ORPHANED = "[Output withheld: the turn that ran this command has ended, so nothing can mask it.]\n";
const SHELL_OUTPUT_FAILED = "[Output withheld: it could not be masked.]\n";
const SHELL_COMMAND_GONE = "[Not run: the sandbox no longer holds this command; its turn has ended, or it already ran.]\n";

// A shell command with its values, held for the script that runs it to fetch once (POST /shell-command). Never in what
// Cursor records: Cursor writes a hook's rewrite into the call's own arguments and echoes it to its servers in the
// shell's result. What Cursor does record is the wrapper (cursor-hook-script.ts): the script's path, this turn's id, an
// opaque id and the command as the model wrote it, references and tokens in place; nothing it did not already have
// beyond the script's path, and the tmux line it runs is handed over here, not there. Dropped when fetched, when its
// turn retires, or after a day nobody ran it.
interface HeldCommand {
    readonly turn: string;
    // What runs: the privacy shield's tokens read back to their values, a secret's reference still a reference.
    readonly command: string;
    // As the model wrote it: what a card shows, the tool list and the output filter read, and the terminal names.
    readonly said: string;
    readonly cwd: string | undefined;
    readonly at: number;
    // The command with its secrets resolved, set once the gate let it run (beforeShellExecution).
    readonly resolved?: string;
}
const HELD_COMMAND_MS = 24 * 60 * 60 * 1000;
// Where Cursor starts a shielded command whose working directory held a token: one that exists, since the real one
// stays out of its arguments too; the script then runs the command in the real one.
const NEUTRAL_CWD = "/";

const editsOf = (value: unknown): { old_string: string; new_string: string }[] =>
    Array.isArray(value)
        ? value.flatMap((edit) =>
              isRecord(edit) && typeof edit["new_string"] === "string"
                  ? [{ old_string: typeof edit["old_string"] === "string" ? edit["old_string"] : "", new_string: edit["new_string"] }]
                  : [],
          )
        : [];

const asString = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

// The hooks the script answers, by Cursor's names.
export type CursorHookName = "sessionStart" | "beforeSubmitPrompt" | "beforeShellExecution" | "preToolUse" | "beforeMCPExecution" | "beforeReadFile" | "afterFileEdit";

// The hooks the privacy shield reads a Cursor turn through; each must name this daemon's script for a shielded turn to run.
export const SHIELD_HOOKS: readonly CursorHookName[] = ["preToolUse", "beforeReadFile", "afterFileEdit"];
// The hooks a tool list is checked through: every built-in call, the shell's narrowing, and an MCP server's tools.
export const LIST_HOOKS: readonly CursorHookName[] = ["preToolUse", "beforeShellExecution", "beforeMCPExecution"];

// Said when a call arrives naming no tool at all on a turn held to a list: nothing can tell whether the list allows it.
const UNNAMED_CALL = "This call named no tool this turn's tool list could be checked against, so it was refused. Do not retry it: say plainly what you could not do.";

// A refusal, in the shape every hook that can refuse reads.
// A type, not an interface, so it is a HookAnswer: an interface carries no index signature.
type HookRefusal = {
    readonly permission: "deny";
    readonly user_message: string;
    readonly agent_message: string;
};
const denied = (reason: string): HookRefusal => ({ permission: "deny", user_message: reason, agent_message: reason });

// The skill folders Cursor reads skills from (its own, Claude's, the workspace's canonical one).
const SKILL_DIRS = ["/.agents/skills/", "/.claude/skills/", "/.cursor/skills/"] as const;

// The refusal for a read of a withheld skill's files, or undefined.
const deniedSkillRefusal = (path: string, withheld: readonly string[] | undefined): string | undefined => {
    const name = withheld?.find((skill) => SKILL_DIRS.some((dir) => path.includes(`${dir}${skill}/`)));
    return name === undefined ? undefined : `The ${name} skill is not available to this conversation: its persona or an approval gate withholds it. Carry on without it.`;
};

// The handlers behind the socket's endpoints, each reading the payload shape its own hook sends.
interface CursorHandlers {
    readonly verdictFor: (payload: GateRequest) => Promise<HookAnswer>;
    readonly mcpVerdictFor: (payload: McpRequest) => Promise<HookAnswer>;
    readonly environmentFor: (payload: TurnScopedRequest) => HookAnswer;
    readonly instructionsFor: (payload: TurnScopedRequest) => HookAnswer;
    readonly readVerdictFor: (payload: ReadRequest) => Promise<HookAnswer>;
    readonly toolVerdictFor: (payload: ToolRequest) => Promise<HookAnswer>;
    readonly shellCommandFor: (payload: ShellCommandRequest) => HookAnswer;
    readonly shellOutputFor: (payload: ShellOutputRequest) => Promise<HookAnswer>;
    readonly editedFor: (payload: EditedRequest) => HookAnswer;
}

// SAFETY: every Cursor hook sends a JSON object; each field the handlers read is checked where it is read (asString,
// isRecord), so a payload of another shape reads as naming nothing.
const fields = <T>(payload: JsonValue): T => payload as T;

// A tool input handed back to Cursor, rewritten or not.
const inputAnswer = (input: CursorHookToolInput): JsonValue =>
    // SAFETY: the input came in as parsed JSON (the hook's payload), and a rewrite only puts strings into it.
    input as JsonValue;

// Every endpoint the script posts to, each with the harmless answer its script writes when it cannot reach this socket at
// all. The gate and the shield's own fail closed when they fail, since a command, a read or an output that could not be
// checked is exactly what must not reach the model.
const cursorEndpoints = (handlers: CursorHandlers, logger: Logger) =>
    ({
        "/session-env": { answer: (payload) => handlers.environmentFor(fields(payload)), unreadable: {} },
        "/prompt": { answer: (payload) => handlers.instructionsFor(fields(payload)), unreadable: { continue: true } },
        "/read": {
            answer: (payload) => handlers.readVerdictFor(fields(payload)),
            unreadable: { permission: "allow" },
            failed: (error) => {
                logger.error({ err: error }, "cursor: a file read could not be checked, refusing it");
                return {
                    permission: "deny",
                    user_message: `This file could not be checked (${errorMessage(error)}), so it was not read.`,
                };
            },
        },
        "/pre-tool": {
            answer: (payload) => handlers.toolVerdictFor(fields(payload)),
            unreadable: {},
            failed: (error) => {
                logger.error({ err: error }, "cursor: a tool call could not be checked, refusing it");
                return denied(`This tool call could not be checked (${errorMessage(error)}), so it did not run.`);
            },
        },
        "/shell-command": { answer: (payload) => handlers.shellCommandFor(fields(payload)), unreadable: {} },
        "/shell-output": {
            answer: (payload) => handlers.shellOutputFor(fields(payload)),
            unreadable: {},
            failed: (error) => {
                logger.error({ err: error }, "cursor: a command's output could not be masked, withholding it");
                return { output: SHELL_OUTPUT_FAILED };
            },
        },
        "/edited": { answer: (payload) => handlers.editedFor(fields(payload)), unreadable: {} },
        "/mcp": {
            answer: (payload) => handlers.mcpVerdictFor(fields(payload)),
            unreadable: { permission: "allow" },
            failed: (error) => {
                logger.error({ err: error }, "cursor: an MCP call could not be checked, refusing it");
                return denied(`This MCP call could not be checked (${errorMessage(error)}), so it did not run.`);
            },
        },
        // The policy gate already turns a failed consult into a refusal (runtimes/daemon-tools/policy-gate.ts); this is only a throw past it.
        "/gate": {
            answer: (payload) => handlers.verdictFor(fields(payload)),
            unreadable: { permission: "allow" },
            failed: (error) => {
                logger.error({ err: error }, "cursor: command gate failed, refusing the command");
                const reason = guardFailed(error);
                return { permission: "deny", agent_message: reason, user_message: reason };
            },
        },
    }) satisfies Record<string, HookEndpoint>;

// Where a hook's call lands: its turn, outside every turn (the owner's own Cursor, no turn live), or refused.
type Placement = { readonly turn: CursorGateTurn; readonly policy: PolicyTurn } | { readonly outside: true } | { readonly refused: string };

// The live turns as every handler reads them, built once per service.
interface TurnRegistry {
    readonly turns: Map<string, CursorGateTurn>;
    readonly held: Map<string, HeldCommand>;
    // The owner's command rules, asked through the runtime-neutral policy gate (runtimes/daemon-tools/policy-gate.ts),
    // which places a call in its turn and refuses one it cannot place. A call while no turn at all is live is a Cursor
    // process this daemon never started (the owner's own, reading the same machine-wide hooks file), which no turn's
    // rules govern.
    readonly policy: PolicyGate;
    // The Cursor turn behind each registered policy turn, so a placement answers both.
    readonly behind: WeakMap<PolicyTurn, CursorGateTurn>;
    // The turns whose terminal the panel has been told about, so each is surfaced once.
    readonly surfaced: WeakSet<CursorGateTurn>;
    readonly scriptPath: string;
    readonly logger: Logger;
}

// Every hook that can refuse a call places it the way the gate does: its exact turn, the only live one, outside every
// turn when none is live, and refused when several are and it names none of them.
const placeIn = (registry: TurnRegistry, conversationId: string | undefined): Placement => {
    const placed = registry.policy.place(conversationId);
    if ("turn" in placed) {
        const turn = registry.behind.get(placed.turn);
        return turn === undefined ? { refused: guardFailed(new Error("the turn's hooks are not registered")) } : { turn, policy: placed.turn };
    }
    return placed;
};

// The turn a shield hook speaks for: its exact id, else the only turn running.
const turnIn = (registry: TurnRegistry, conversationId: string | undefined): CursorGateTurn | undefined => {
    const exact = conversationId === undefined ? undefined : registry.turns.get(conversationId);
    if (exact !== undefined) {
        return exact;
    }
    return registry.turns.size === 1 ? [...registry.turns.values()][0] : undefined;
};

// The shield a hook speaks for, found as the gate finds its turn, since a privacy check that names the wrong turn errs
// toward checking. With several turns live and none named, any one the shield reads stands in, so a call nothing can
// place is checked rather than waved through.
const shieldIn = (registry: TurnRegistry, conversationId: string | undefined): CursorHookShield | undefined => {
    const turn = turnIn(registry, conversationId);
    return turn === undefined ? [...registry.turns.values()].find((each) => each.shield !== undefined)?.shield : turn.shield;
};

const holdIn = (registry: TurnRegistry, command: HeldCommand): string => {
    for (const [id, each] of registry.held) {
        if (command.at - each.at > HELD_COMMAND_MS) {
            registry.held.delete(id);
        }
    }
    const id = randomUUID();
    registry.held.set(id, command);
    return id;
};

// The rules on a shell command, with whether they put it on a card of their own, which a `default`-mode turn's card
// would only repeat. Named for Cursor's own tool, so the card, transcript and runtime all agree on what ran; the shell's
// own cwd places an install the way Claude Code's hook input does.
const rulesOn = async (
    registry: TurnRegistry,
    policy: PolicyTurn,
    command: string,
    cwd: string | undefined,
): Promise<{ readonly verdict: Awaited<ReturnType<typeof consultPolicy>>; readonly carded: boolean }> => {
    let carded = false;
    const noting: PolicyTurn = {
        ...policy,
        push: (event) => {
            carded ||= event.kind === "permission";
            policy.push(event);
        },
    };
    const verdict = await consultPolicy(
        noting,
        { tool: "Shell", input: { command }, program: command, cwd },
        {
            // A gate that failed refuses at once, as the hook's failClosed does for a script that never answered.
            failed: (error) => {
                registry.logger.error({ err: error }, "cursor: command gate failed, refusing the command");
                return guardFailed(error);
            },
        },
    );
    return { verdict, carded };
};

// The command a gate payload stands for: what will run (with the privacy shield's values and a secret's reference, held
// by the wrapper's id), as the model wrote it, and the held entry, if preToolUse wrapped it (it runs first).
const gatedCommand = (registry: TurnRegistry, raw: string | undefined) => {
    const wrapped = raw === undefined ? undefined : wrappedCommand(raw);
    const holding = wrapped === undefined ? undefined : registry.held.get(wrapped.id);
    const command = wrapped === undefined ? raw : (holding?.command ?? wrapped.shown);
    return { command, said: holding?.said ?? wrapped?.shown ?? command, held: wrapped === undefined || holding === undefined ? undefined : { id: wrapped.id, holding } };
};

// The command's secrets, resolved once it may run, after the rules and the person read it with its references, so nobody
// is asked to release a value for a command that was refused. The refusal, or undefined once the held entry carries them.
const resolveHeld = async (registry: TurnRegistry, turn: CursorGateTurn, held: { readonly id: string; readonly holding: HeldCommand } | undefined): Promise<string | undefined> => {
    if (held === undefined || turn.secrets === undefined) {
        return undefined;
    }
    const resolved = await turn.secrets.resolve(held.holding.command);
    if ("refusal" in resolved) {
        return resolved.refusal;
    }
    registry.held.set(held.id, { ...held.holding, resolved: resolved.command });
    return undefined;
};

// beforeShellExecution: the tool list's narrowing, the owner's rules, the person in `default` mode, and then the
// command's secrets, in that order.
const gateHandler =
    (registry: TurnRegistry) =>
    async (payload: GateRequest): Promise<HookAnswer> => {
        const { command, said, held } = gatedCommand(registry, asString(payload.command));
        const placed = command === undefined ? ({ outside: true } as const) : placeIn(registry, asString(payload.conversation_id));
        if (command === undefined || said === undefined || "outside" in placed) {
            return { permission: "allow" };
        }
        if ("refused" in placed) {
            return denied(placed.refused);
        }
        const { turn } = placed;
        // Again here, as well as in preToolUse: a call whose preToolUse never ran is still held to the list.
        const listed = turn.allowedTools === undefined ? undefined : hookToolRefusal(turn.allowedTools, "Shell", said);
        if (listed !== undefined) {
            return denied(listed);
        }
        const { verdict, carded } = await rulesOn(registry, placed.policy, command, held?.holding.cwd ?? asString(payload.cwd));
        if (verdict.decision === "deny") {
            return denied(verdict.reason);
        }
        const answer = turn.owner === undefined || carded ? undefined : await turn.owner.approve(shellAsk(said));
        const refusal = answer?.allow === false ? answer.reason : await resolveHeld(registry, turn, held);
        if (refusal !== undefined) {
            return denied(refusal);
        }
        // What the gate had to say about an allowed command (where an install writes) goes to the agent alone.
        return verdict.context === undefined ? { permission: "allow" } : { permission: "allow", agent_message: verdict.context };
    };

// The shell's card, as the person reads it: the command as the model wrote it.
const shellAsk = (said: string): Parameters<CursorOwner["approve"]>[0] => ({
    toolName: "Shell",
    displayName: "Run command",
    title: "Run this command?",
    program: { text: said, language: "bash" },
});

// beforeMCPExecution: an MCP server's tool, the one hook that names the server, so the one place an `mcp__server__tool`
// entry is read.
const mcpHandler =
    (registry: TurnRegistry) =>
    async (payload: McpRequest): Promise<HookAnswer> => {
        const placed = placeIn(registry, asString(payload.conversation_id));
        if ("outside" in placed) {
            return { permission: "allow" };
        }
        if ("refused" in placed) {
            return denied(placed.refused);
        }
        const { turn } = placed;
        const server = asString(payload.mcp_server_name);
        const tool = asString(payload.tool_name);
        if (server === undefined || tool === undefined) {
            return turn.allowedTools === undefined ? { permission: "allow" } : denied(UNNAMED_CALL);
        }
        const listed = turn.allowedTools === undefined ? undefined : mcpToolRefusal(turn.allowedTools, server, tool);
        if (listed !== undefined) {
            return denied(listed);
        }
        // The daemon's own custom tools ask in their handlers, which every call to one reaches.
        const answer = turn.owner === undefined || server === CUSTOM_TOOLS_SERVER ? undefined : await turn.owner.approve(mcpAsk(server, tool));
        return answer?.allow === false ? denied(answer.reason) : { permission: "allow" };
    };

// beforeReadFile: a withheld skill's files and a file holding a stored value are refused for whichever turn the read is
// placed in (every live one when nothing places it, since a check that names the wrong turn errs toward checking), then
// the privacy shield reads it.
const readHandler =
    (registry: TurnRegistry) =>
    async (payload: ReadRequest): Promise<{ permission: "allow" | "deny"; user_message?: string }> => {
        const path = asString(payload.file_path);
        if (path === undefined) {
            return { permission: "allow" };
        }
        const content = typeof payload.content === "string" ? payload.content : undefined;
        const placed = turnIn(registry, asString(payload.conversation_id));
        for (const turn of placed === undefined ? registry.turns.values() : [placed]) {
            const refusal = deniedSkillRefusal(path, turn.deniedSkills) ?? ((await turn.secrets?.holds(path, content)) === true ? secretReadRefusal(path) : undefined);
            if (refusal !== undefined) {
                return { permission: "deny", user_message: refusal };
            }
        }
        const shield = shieldIn(registry, asString(payload.conversation_id));
        if (shield === undefined) {
            return { permission: "allow" };
        }
        const bytes = (field: unknown): Buffer | undefined => (typeof field === "string" ? Buffer.from(field, "base64") : undefined);
        const refusal = await shield.read({
            path,
            content,
            image: bytes(payload.image_base64),
            document: bytes(payload.document_base64),
            opaque: payload.opaque === true,
        });
        return refusal === undefined ? { permission: "allow" } : { permission: "deny", user_message: refusal };
    };

// What stops a built-in call before the shield reads it: the turn's list, and a whole-file write over a file holding a
// stored value, whose result would echo it. An MCP call is checked in beforeMCPExecution, which names its server.
const preToolRefusal = async (turn: CursorGateTurn, tool: string, said: string | undefined, payload: ToolRequest): Promise<string | undefined> => {
    const listed = tool.startsWith("MCP:") || turn.allowedTools === undefined ? undefined : hookToolRefusal(turn.allowedTools, tool, said);
    if (listed !== undefined) {
        return listed;
    }
    const target = tool === "Write" ? AskFieldsSchema.safeParse(payload.tool_input).data?.file_path : undefined;
    const existing = typeof payload.existing_content === "string" ? payload.existing_content : undefined;
    return target !== undefined && (await turn.secrets?.holds(target, existing)) === true ? secretWriteRefusal(target) : undefined;
};

// The person's word on a built-in call in `default` mode; a shell command is put to them in beforeShellExecution, after
// the rules, whose own card stands in for theirs, and an MCP call in beforeMCPExecution.
const ownerRefusal = async (turn: CursorGateTurn, tool: string, input: CursorHookToolInput): Promise<string | undefined> => {
    const ask = tool === "Shell" || tool.startsWith("MCP:") ? undefined : builtInAsk(tool, AskFieldsSchema.safeParse(input).data ?? {});
    const answer = ask === undefined ? undefined : await turn.owner?.approve(ask);
    return answer?.allow === false ? answer.reason : undefined;
};

// A shell command, wrapped so the script runs it: Cursor's arguments keep the command as the model wrote it, inside a
// wrapper naming the held one; a working directory whose token was read back stays out of them too.
const wrapShell = (registry: TurnRegistry, turn: CursorGateTurn, original: CursorHookToolInput, input: CursorHookToolInput, command: string, said: string): HookAnswer => {
    const cwd = typeof input["cwd"] === "string" && input["cwd"] !== original["cwd"] ? input["cwd"] : undefined;
    const id = holdIn(registry, { turn: turn.conversationId, command: unshieldedCommand(command), said, cwd, at: Date.now() });
    return {
        updated_input: inputAnswer({
            ...original,
            ...(cwd === undefined ? {} : { cwd: NEUTRAL_CWD }),
            command: shieldedCommand(registry.scriptPath, turn.conversationId, id, said),
        }),
    };
};

// preToolUse: a call on its way, held to the turn's list, read by the shield, put to a person in `default` mode, and,
// for a shell command, wrapped so the script runs it: its secrets resolved, its output masked, its run in the panel.
const toolHandler =
    (registry: TurnRegistry) =>
    async (payload: ToolRequest): Promise<HookAnswer> => {
        const tool = asString(payload.tool_name);
        const original = isRecord(payload.tool_input) ? payload.tool_input : undefined;
        const placed = tool === undefined || original === undefined ? ({ outside: true } as const) : placeIn(registry, asString(payload.conversation_id));
        if (tool === undefined || original === undefined || "outside" in placed) {
            return {};
        }
        if ("refused" in placed) {
            return denied(placed.refused);
        }
        const { turn } = placed;
        const said = typeof original["command"] === "string" ? unshieldedCommand(original["command"]) : undefined;
        const refused = await preToolRefusal(turn, tool, said, payload);
        if (refused !== undefined) {
            return denied(refused);
        }
        const existing = typeof payload.existing_content === "string" ? payload.existing_content : undefined;
        const verdict = turn.shield === undefined ? { input: undefined } : await turn.shield.toolCall({ tool, input: original, existing });
        if ("refuse" in verdict) {
            return denied(verdict.refuse);
        }
        const input = verdict.input ?? original;
        const declined = await ownerRefusal(turn, tool, input);
        if (declined !== undefined) {
            return denied(declined);
        }
        const command = input["command"];
        if (tool === "Shell" && typeof command === "string" && command !== "") {
            return wrapShell(registry, turn, original, input, command, said ?? "");
        }
        return verdict.input === undefined ? {} : { updated_input: inputAnswer(verdict.input) };
    };

// Exact turn and id only, and once: the script that runs a wrapped command takes it from here, as the tmux line that runs
// it in the panel where the turn has one, with its secrets resolved where the gate let it run.
const shellCommandHandler =
    (registry: TurnRegistry) =>
    (payload: ShellCommandRequest): { command: string; cwd?: string; aimed?: true } | { refused: string } => {
        const id = asString(payload.id);
        const command = id === undefined ? undefined : registry.held.get(id);
        const turn = command === undefined ? undefined : registry.turns.get(command.turn);
        if (id === undefined || command === undefined || turn === undefined || command.turn !== asString(payload.conversation_id)) {
            return { refused: SHELL_COMMAND_GONE };
        }
        registry.held.delete(id);
        const resolved = command.resolved ?? command.command;
        const terminal = turn.terminal;
        if (terminal !== undefined && !registry.surfaced.has(turn)) {
            registry.surfaced.add(turn);
            turn.push({ kind: "terminal", session: terminal.session });
        }
        return {
            command: terminal === undefined ? resolved : paneCommand(terminal, resolved, command.said),
            ...opt("cwd", command.cwd),
            ...opt("aimed", turn.secrets?.aimed(command.said) === true ? (true as const) : undefined),
        };
    };

// Exact id only: the wrapper names the turn it was made for, and output that outlived its turn is withheld, since nothing
// that could mask it is left. Stored values first, so one becomes its reference before the shield reads the rest.
const shellOutputHandler =
    (registry: TurnRegistry) =>
    async (payload: ShellOutputRequest): Promise<{ output: string }> => {
        const conversationId = asString(payload.conversation_id);
        const turn = conversationId === undefined ? undefined : registry.turns.get(conversationId);
        if (turn === undefined) {
            return { output: SHELL_OUTPUT_ORPHANED };
        }
        const output = typeof payload.output === "string" ? payload.output : "";
        const unvalued = turn.secrets === undefined ? output : await turn.secrets.mask(output, payload.aimed === true);
        return { output: turn.shield === undefined ? unvalued : await turn.shield.shellOutput(unvalued) };
    };

const editedHandler =
    (registry: TurnRegistry) =>
    (payload: EditedRequest) => {
        const shield = shieldIn(registry, asString(payload.conversation_id));
        if (shield === undefined || typeof payload.content !== "string") {
            return {};
        }
        const restored = shield.edited(payload.content, editsOf(payload.edits));
        return restored === undefined ? {} : { content: restored };
    };

// Never uses the gate's single-live-turn fallback: a sessionStart hook can come from an owner's own hand-run Cursor
// process, and handing it a turn's environment would cross the capability boundary. No exact id, no environment.
const environmentHandler =
    (registry: TurnRegistry) =>
    (payload: TurnScopedRequest) => {
        const conversationId = asString(payload.conversation_id);
        return { env: (conversationId === undefined ? undefined : registry.turns.get(conversationId)?.cliEnv) ?? {} };
    };

// Exact id only, for the same reason as the environment above: the append carries the workspace's own standing
// instructions and the persona this turn acts as, neither of which belongs in a Cursor process this daemon didn't start.
// An empty append is omitted rather than sent blank, so Cursor's own prompt is left exactly as it was. `continue` is
// stated rather than left unset: false is how this hook family blocks a prompt outright, and no answer of ours ever means
// that.
const instructionsHandler =
    (registry: TurnRegistry) =>
    (payload: TurnScopedRequest) => {
        const conversationId = asString(payload.conversation_id);
        const append = conversationId === undefined ? undefined : registry.turns.get(conversationId)?.systemAppend;
        return append === undefined || append === "" ? { continue: true } : { continue: true, additional_context: append };
    };

const handlersOf = (registry: TurnRegistry): CursorHandlers => ({
    verdictFor: gateHandler(registry),
    mcpVerdictFor: mcpHandler(registry),
    environmentFor: environmentHandler(registry),
    instructionsFor: instructionsHandler(registry),
    readVerdictFor: readHandler(registry),
    toolVerdictFor: toolHandler(registry),
    shellCommandFor: shellCommandHandler(registry),
    shellOutputFor: shellOutputHandler(registry),
    editedFor: editedHandler(registry),
});

// The hooks file as far as coverage reads it: each hook's commands; an entry of another shape names no script.
const HooksFileSchema = z.object({
    hooks: z.record(z.string(), z.array(z.object({ command: z.string().optional().catch(undefined) }).catch({}))).catch({}),
});

// Whether the hooks file in force names `scriptPath` for every one of `hooks`.
const hooksCover = async (scriptPath: string, hooks: readonly CursorHookName[]): Promise<boolean> => {
    try {
        const installed = HooksFileSchema.parse(JSON.parse(await readFile(enterpriseHooksPath(), "utf8")));
        return hooks.every((hook) => (installed.hooks[hook] ?? []).some((entry) => entry.command?.includes(scriptPath) === true));
    } catch {
        // allow(silent-catch): an absent or unreadable hooks file installs none of the hooks, which is the answer.
        return false;
    }
};

export const createCursorHookService = (socketDir: string, logger: Logger): CursorHookService => {
    const socketPath = join(socketDir, "command-guard.sock");
    const scriptPath = join(socketDir, GATE_SCRIPT_NAME);
    const livePath = join(socketDir, LIVE_TURNS_NAME);
    const registry: TurnRegistry = {
        turns: new Map(),
        held: new Map(),
        policy: createPolicyGate({ logger, noLiveTurn: "allow" }),
        behind: new WeakMap(),
        surfaced: new WeakSet(),
        scriptPath,
        logger,
    };
    const { turns, held } = registry;

    // The live turns' ids, for the script to refuse their calls by when this socket cannot answer it
    // (cursor-hook-script.ts). Written whole, one write after another, renamed into place so the script never reads half.
    let writing = Promise.resolve();
    const publishLive = (): void => {
        const ids = JSON.stringify([...turns.keys()]);
        writing = writing.then(async () => {
            try {
                await writeFile(`${livePath}.part`, ids, { mode: 0o644 });
                await rename(`${livePath}.part`, livePath);
            } catch (error) {
                logger.warn({ err: error }, "cursor: could not record the live turns for the hook script");
            }
        });
    };

    const socket = createHookSocket(socketPath, cursorEndpoints(handlersOf(registry), logger));

    return {
        start: async () => {
            if (socket.listening()) {
                return;
            }
            await socket.listen();
            publishLive();
            await writeFile(scriptPath, gateScript(socketPath, livePath), { mode: 0o755 });
            // Best-effort: a container without /etc access is real; answer is unenforced rules, not refusing to boot.
            const hooksPath = enterpriseHooksPath();
            try {
                await mkdir(dirname(hooksPath), { recursive: true });
                await writeFile(hooksPath, hooksJson(scriptPath), { mode: 0o644 });
            } catch (error) {
                logger.warn({ err: error, path: hooksPath }, "cursor: could not install the command-guard hook, rules will not apply");
            }
        },
        register: (turn) => {
            turns.set(turn.conversationId, turn);
            const registered: PolicyTurn = { gate: turn.gate, push: turn.push };
            registry.behind.set(registered, turn);
            const retirePolicy = registry.policy.register(turn.conversationId, registered);
            publishLive();
            return () => {
                retirePolicy();
                if (turns.get(turn.conversationId) !== turn) {
                    return;
                }
                turns.delete(turn.conversationId);
                for (const [id, command] of held) {
                    if (command.turn === turn.conversationId) {
                        held.delete(id);
                    }
                }
                publishLive();
            };
        },
        ready: () => socket.listening(),
        covers: async (hooks = SHIELD_HOOKS) => socket.listening() && (await hooksCover(scriptPath, hooks)),
        paths: () => ({ socket: socketPath, script: scriptPath, hooks: enterpriseHooksPath() }),
        close: async () => {
            turns.clear();
            publishLive();
            await writing;
            await socket.close();
        },
    };
};
