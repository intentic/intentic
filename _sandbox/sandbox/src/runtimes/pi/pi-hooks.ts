import { isAbsolute, resolve } from "node:path";
import type { HookCallback, HookJSONOutput, PostToolUseHookInput, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import type { JsonValue } from "@intentic/base/fetch-json";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { agentSessionName } from "@intentic/sandbox-contract/session-names";
import { z } from "zod";
import type { AgentRequest } from "../../agent/providers/agent-request.js";
import { WITHHELD, redactionHooks, withheld } from "../../agent/tools/agent-redaction.js";
import { bashTmuxHooks } from "../../agent/tools/agent-terminals.js";
import type { CommandGuard } from "../../guard/command-guard.js";
import { mcpServerOf, sealOutside } from "../../guard/outside-results.js";
import type { TurnTaint } from "../../guard/turn-taint.js";
import { resolveCommandSecrets } from "../../secrets/secret-access.js";
import { hasSecretReferences } from "../../secrets/secret-registry.js";
import type { HookAnswer, HookEndpoint } from "../daemon-tools/hook-socket.js";
import { createPolicyGate, guardFailed } from "../daemon-tools/policy-gate.js";

// The daemon's end of the Pi extension's tool hooks (pi-extension.ts): one turn's Pi posts every tool call to a socket
// of this turn's own (pi-rpc.ts) before it runs, and every result after, and does what the answer says. Before a call:
// the turn's tool list and the owner's command rules (policy-gate.ts, a held call parking on a card while Pi waits),
// then a shell line's rewrite, the one the Claude Code loop's hook makes (agent-terminals.ts): through bin/tmux-run into
// the conversation's terminal panel, its `{{secret:name}}` references resolved on the way. After a result: every stored
// secret masked to its reference (agent-redaction.ts), outside content sealed and marked (outside-results.ts), and the
// owner's `file.edited` checks run on a file an edit or write tool changed. Every answer the daemon cannot give is a
// refusal or a withheld result, never a call let through unchecked.

// The one key the turn's calls are placed under: the socket is this turn's alone, so nothing else can be asking.
const TURN_KEY = "turn";

// Pi's built-in tools under the names the Claude Code loop gives the same tools: what a turn's tool list, the command
// gate's shell classification and the outside-content table are written in. An MCP tool is already `mcp__<server>__<tool>`
// on both, and any other name is checked as it is, so a list that does not name it refuses it.
const CLAUDE_NAMES: ReadonlyMap<string, string> = new Map([
    ["bash", "Bash"],
    ["read", "Read"],
    ["edit", "Edit"],
    ["write", "Write"],
    ["grep", "Grep"],
    ["find", "Glob"],
    ["ls", "LS"],
]);

export const piToolName = (tool: string): string => CLAUDE_NAMES.get(tool) ?? tool;

// Pi's Windows shell, which the gate's shell table does not name: its command is handed over as the program outright,
// so the rules read it rather than wave it through as a tool that runs nothing.
const POWERSHELL = "powershell";

// A tool's input and a result's content blocks as JSON, which is all the extension can post.
const ToolInputSchema = z.record(z.string(), z.json());
type ToolInput = z.infer<typeof ToolInputSchema>;
const ContentSchema = z.array(z.json());
type Content = z.infer<typeof ContentSchema>;

// What the extension posts, as far as an answer reads it.
const ToolCallSchema = z.object({ tool: z.string(), id: z.string().optional(), input: ToolInputSchema, cwd: z.string().optional() });
const ToolResultSchema = z.object({ tool: z.string(), input: ToolInputSchema, content: ContentSchema, isError: z.boolean().optional(), cwd: z.string().optional() });

// The fields of a call's input this module reads.
const CommandSchema = z.object({ command: z.string() });
const PathSchema = z.object({ path: z.string() });

// What the Claude Code loop's hooks answer, as far as a Pi call takes it: a refusal, a changed input, a changed result
// (the redaction hook's sentence in place of a result it could not mask, or the masked blocks).
const HookSaidSchema = z.object({
    hookSpecificOutput: z
        .object({
            permissionDecision: z.string().optional(),
            permissionDecisionReason: z.string().optional(),
            updatedInput: ToolInputSchema.optional(),
            updatedToolOutput: z.union([z.string(), ContentSchema]).optional(),
        })
        .optional(),
});
const SealedSchema = z.object({ content: ContentSchema });
type HookSaid = NonNullable<z.infer<typeof HookSaidSchema>["hookSpecificOutput"]>;

export const UNREADABLE_CALL =
    "The sandbox could not read this tool call, so nothing could check it against your owner's rules and it did not run. " +
    "Do not retry it: say plainly what you could not do.";

// The live half of a turn, attached by the loop once it has its gate (pi-agent.ts).
export interface PiHookTurn {
    readonly gate: CommandGuard;
    readonly taint: TurnTaint;
    // The turn's stream: a held call's card, the terminal frame.
    readonly push: (event: AgentEvent) => void;
    // The turn's watchdog hold, taken while a card waits on a person.
    readonly hold: () => () => void;
}

export interface PiHooks {
    // What the turn's socket answers, by path (hook-socket.ts).
    readonly endpoints: Readonly<Record<string, HookEndpoint>>;
    // Settles when the extension has loaded and reached the socket: a Pi that never says so has nothing in front of its
    // tools, and the turn does not start on it.
    readonly ready: Promise<void>;
    // Names the Pi session the turn runs, whose id names the terminal panel's tmux session.
    readonly session: (sessionFile: string) => void;
    readonly attach: (turn: PiHookTurn) => () => void;
}

export interface PiHooksOptions {
    // Whether a shell line runs through bin/tmux-run (agent-terminals.ts tmuxRunEnabled).
    readonly tmux: boolean;
    // The daemon's own servers, whose results the door already sealed (daemon-servers.ts): sealed again here they would
    // carry two envelopes.
    readonly sealedAtDoor: ReadonlySet<string>;
}

/** The id Pi's session file names (`<timestamp>_<uuid>.jsonl`): its uuid, which the panel's session name is cut from. */
export const piSessionKey = (sessionFile: string): string => {
    const base = sessionFile.slice(sessionFile.lastIndexOf("/") + 1).replace(/\.jsonl$/u, "");
    return base.slice(base.lastIndexOf("_") + 1);
};

// A type rather than an interface: a JSON value, which an interface's open shape is not.
type TextBlock = { readonly type: "text"; readonly text: string };

const textBlock = (text: string): TextBlock => ({ type: "text", text });

// The hook callbacks the Claude Code loop runs, called here on a Pi call shaped as their input: one rewrite and one mask,
// whichever runtime's shell they serve.
const preToolUse = (tool: string, input: ToolInput, id: string, session: string, cwd: string): PreToolUseHookInput => ({
    hook_event_name: "PreToolUse",
    tool_name: tool,
    tool_input: input,
    tool_use_id: id,
    session_id: session,
    transcript_path: "",
    cwd,
});
const postToolUse = (tool: string, input: ToolInput, response: Content, cwd: string): PostToolUseHookInput => ({
    hook_event_name: "PostToolUse",
    tool_name: tool,
    tool_input: input,
    tool_response: response,
    tool_use_id: "",
    session_id: "",
    transcript_path: "",
    cwd,
});

// What a hook said, or undefined for an answer that changes nothing or that this reading does not recognise.
const saidBy = (output: HookJSONOutput): HookSaid | undefined => HookSaidSchema.safeParse(output).data?.hookSpecificOutput;

export const createPiHooks = (request: AgentRequest, options: PiHooksOptions): PiHooks => {
    const policy = createPolicyGate();
    let live: PiHookTurn | undefined;
    let sessionKey: string | undefined;
    let surfaced = false;
    // Marks a result made before the loop attached: the taint bit may only err toward set, so none is dropped.
    const marks: string[] = [];
    const mark = (source: string): void => {
        if (live === undefined) {
            marks.push(source);
            return;
        }
        live.taint.mark(source);
    };
    let settleReady: () => void = () => {};
    const ready = new Promise<void>((settle) => {
        settleReady = settle;
    });

    const tools = request.tools;
    const tmuxHook: HookCallback | undefined = options.tmux
        ? bashTmuxHooks(
              Object.keys(tools.cliEnv ?? {}),
              request.spec.isolation,
              request.spec.conversationId,
              tools.secrets,
              tools.heavyCommands,
              tools.offloadCommands,
          ).PreToolUse?.[0]?.hooks[0]
        : undefined;
    const maskHook: HookCallback | undefined = tools.secrets === undefined ? undefined : redactionHooks(tools.secrets.list).PostToolUse?.[0]?.hooks[0];

    // A shell line as it will run: through the panel's tmux session where there is one, else with its secret
    // references resolved in place. A reference the turn may not use refuses the call.
    const shellLine = async (input: ToolInput, id: string, cwd: string): Promise<{ readonly refuse: string } | { readonly input: ToolInput }> => {
        const command = CommandSchema.safeParse(input).data?.command;
        if (command === undefined) {
            return { input };
        }
        const session = sessionKey === undefined ? undefined : agentSessionName(sessionKey);
        if (tmuxHook !== undefined && sessionKey !== undefined && session !== undefined) {
            const said = saidBy(await tmuxHook(preToolUse("Bash", input, id, sessionKey, cwd), id, { signal: request.signal }));
            if (said?.permissionDecision === "deny") {
                return { refuse: said.permissionDecisionReason ?? "This command could not be run." };
            }
            if (said?.updatedInput === undefined) {
                return { input };
            }
            // The first line through the panel's session puts it in the panel, as ACP's first terminal does.
            if (!surfaced) {
                surfaced = true;
                live?.push({ kind: "terminal", session });
            }
            return { input: said.updatedInput };
        }
        if (tools.secrets === undefined || !hasSecretReferences(command)) {
            return { input };
        }
        const resolved = await resolveCommandSecrets(command, tools.secrets);
        return "refusal" in resolved ? { refuse: resolved.refusal } : { input: { ...input, command: resolved.command } };
    };

    const toolCall = async (payload: JsonValue): Promise<HookAnswer> => {
        const parsed = ToolCallSchema.safeParse(payload);
        if (!parsed.success) {
            return { block: true, reason: UNREADABLE_CALL };
        }
        const { tool, input, id = "", cwd = request.spec.cwd } = parsed.data;
        const name = piToolName(tool);
        const program = tool === POWERSHELL ? CommandSchema.safeParse(input).data?.command : undefined;
        const verdict = await policy.consult(TURN_KEY, { tool: name, input, cwd, program }, { failed: guardFailed });
        if (verdict.decision === "deny") {
            return { block: true, reason: verdict.reason };
        }
        // A rewrite the policy asked for (none does on this turn today) hands back a JSON object, or the call is refused.
        const allowed = verdict.decision === "rewrite" ? ToolInputSchema.safeParse(verdict.input).data : input;
        if (allowed === undefined) {
            return { block: true, reason: UNREADABLE_CALL };
        }
        const line = name === "Bash" ? await shellLine(allowed, id, cwd) : { input: allowed };
        if ("refuse" in line) {
            return { block: true, reason: line.refuse };
        }
        const answer: Record<string, JsonValue> = {};
        if (line.input !== input) {
            answer["input"] = line.input;
        }
        if (verdict.context !== undefined) {
            answer["context"] = verdict.context;
        }
        return answer;
    };

    // The owner's per-edit checks on a file an edit or write tool changed, as Claude Code's are said after its Edit.
    const editNotes = async (name: string, input: ToolInput, cwd: string): Promise<string[]> => {
        const path = PathSchema.safeParse(input).data?.path;
        const reviewers = request.hooks.editReviewers ?? [];
        if ((name !== "Edit" && name !== "Write") || path === undefined || reviewers.length === 0) {
            return [];
        }
        const file = isAbsolute(path) ? path : resolve(cwd, path);
        const notes = await Promise.all(
            reviewers.map((reviewer) =>
                reviewer(file, "this edit").catch(
                    // allow(silent-catch): a reviewer that throws has nothing to say about this edit, as on the Claude loop
                    () => undefined,
                ),
            ),
        );
        return notes.filter((note): note is string => note !== undefined);
    };

    const toolResult = async (payload: JsonValue): Promise<HookAnswer> => {
        const parsed = ToolResultSchema.safeParse(payload);
        if (!parsed.success) {
            return { content: [textBlock(WITHHELD)] };
        }
        const { tool, input, isError = false, cwd = request.spec.cwd } = parsed.data;
        const name = piToolName(tool);
        let content = parsed.data.content;
        if (maskHook !== undefined) {
            const masked = saidBy(await maskHook(postToolUse(name, input, content, cwd), undefined, { signal: request.signal }))?.updatedToolOutput;
            // A result the secrets could not be read to mask comes back as one sentence in its place.
            content = masked === undefined ? content : Array.isArray(masked) ? masked : [textBlock(masked)];
        }
        const server = mcpServerOf(name);
        if (server === undefined || !options.sealedAtDoor.has(server)) {
            // Sealed as an MCP result is, `{ content }`, whose text blocks are what the envelope wraps.
            const unsealed = { content };
            const sealed = sealOutside(name, input, unsealed, mark);
            content = sealed === unsealed ? content : (SealedSchema.safeParse(sealed).data?.content ?? content);
        }
        const notes = isError ? [] : await editNotes(name, input, cwd);
        if (notes.length > 0) {
            content = [...content, textBlock(notes.join("\n\n"))];
        }
        return content === parsed.data.content ? {} : { content };
    };

    return {
        endpoints: {
            "/ready": {
                answer: () => {
                    settleReady();
                    return {};
                },
                unreadable: {},
            },
            "/tool-call": {
                answer: toolCall,
                unreadable: { block: true, reason: UNREADABLE_CALL },
                failed: (error) => ({ block: true, reason: guardFailed(error) }),
            },
            "/tool-result": {
                answer: toolResult,
                unreadable: { content: [textBlock(WITHHELD)] },
                failed: (error) => ({ content: [textBlock(withheld(error))] }),
            },
        },
        ready,
        session: (sessionFile) => {
            sessionKey = piSessionKey(sessionFile);
        },
        attach: (turn) => {
            live = turn;
            for (const source of marks.splice(0)) {
                turn.taint.mark(source);
            }
            const retire = policy.register(TURN_KEY, {
                gate: turn.gate,
                push: turn.push,
                hold: turn.hold,
                allowedTools: request.policy.allowedTools,
            });
            return () => {
                retire();
                if (live === turn) {
                    live = undefined;
                }
            };
        },
    };
};
