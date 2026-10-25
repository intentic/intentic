import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { errorMessage } from "@intentic/base/errors";
import { z } from "zod";
import type { TurnTools } from "../../agent/providers/agent-request.js";
import { tmuxRunEnabled } from "../../agent/tools/agent-terminals.js";
import { toolAllowed } from "../../agent/tools/tool-allowlist.js";
import type { EditReviewer } from "../../agent/verification/agent-diagnostics.js";
import type { TurnPlacement } from "../../conversations/worktrees/isolation.js";
import { GATE_SERVER, type GateCall, type GateHooks, NOT_A_HOOK } from "../daemon-tools/policy-gate-server.js";
import type { PolicyInput, PolicyVerdict } from "../daemon-tools/policy-gate.js";
import { opt } from "../../opt.js";
import type { JsonValue } from "./codex-app-server.js";
import { createShellLines, type ShellLineOutcome } from "../decorators/shell-line.js";

// The owner's policy in front of every Codex tool: per-thread hooks whose handlers are `mcp_tool` calls on the daemon's
// `gate` server (policy-gate-server.ts, mounted on the turn's door lease by daemon-servers.ts). PreToolUse sees every
// function tool before it runs (exec_command as `Bash`, apply_patch, `mcp__server__tool`, spawn_agent), so a rule can hold
// any of them on a card; PostToolUse marks the turn's taint bit and runs the edit checks; Stop runs the repositories'
// end-of-turn checks once. What the gate lets a shell command through as, this module decides: through the terminal
// panel's tmux wrapper, with its `{{secret:…}}` references resolved, and under the masking wrapper while the turn holds
// stored secrets.
//
// Codex runs a call whose hook failed (an error, a timeout, an answer it cannot parse): its hooks fail open. What keeps
// that from being silent is the loop's (codex-agent.ts): the gate is confirmed connected before the turn starts, every
// answer is recorded here by Codex's call id (which is also its item id), a command or patch Codex then asks approval for
// is let through only if the gate allowed that very call, and a call that starts without an answer here, or a failed
// PreToolUse hook on the turn's own thread, stops the turn.

// Longer than any card can wait: a hook that times out is a hook that let the call through, so the gate's own answer
// (which a card's wait, or the turn's end, always settles) must be what ends the wait.
export const CODEX_PRE_TOOL_TIMEOUT_SEC = 30 * 24 * 3_600;
// The edit checks run commands with their own timeouts; past this one the findings are not worth the stall.
const CODEX_POST_TOOL_TIMEOUT_SEC = 30 * 60;
const CODEX_STOP_TIMEOUT_SEC = 60 * 60;

// What Codex says, on its warning channel, once per thread whose hooks were loaded without its review prompt. The
// daemon wrote them; the reader has nothing to act on. The flag it names is the Codex CLI's own words, checked against
// the installed binary (agent/providers/tests/vendor-phrases.integration.test.ts).
export const HOOK_TRUST_FLAG = "dangerously-bypass-hook-trust";
export const HOOK_TRUST_WARNING = new RegExp(HOOK_TRUST_FLAG);

// Keys of thread/start's `config`, as dotted paths into Codex's config.toml.
export type CodexConfigLayer = Record<string, JsonValue>;

const hookOn = (tool: string, input: Readonly<Record<string, JsonValue>>, timeout: number): JsonValue => [
    { hooks: [{ type: "mcp_tool", server: GATE_SERVER, tool, input, timeout }] },
];

/**
 * The per-thread hook configuration (thread/start's `config`): every placeholder names a field Codex always sends, since
 * a missing one fails the hook, and a failed hook lets the call through. No Stop hook while planning: the turn's
 * end-of-turn checks run once, after the change exists.
 */
export const codexHooksConfig = (key: string, planning: boolean) => {
    const config: CodexConfigLayer = {};
    Object.assign(config, {
    "hooks.PreToolUse": hookOn(
        "pre_tool_use",
        { tool_name: "${tool_name}", tool_input: "${tool_input}", cwd: "${cwd}", tool_use_id: "${tool_use_id}", session_id: "${session_id}", key },
        CODEX_PRE_TOOL_TIMEOUT_SEC,
    ),
    "hooks.PostToolUse": hookOn(
        "post_tool_use",
        { tool_name: "${tool_name}", tool_input: "${tool_input}", tool_response: "${tool_response}", tool_use_id: "${tool_use_id}", key },
        CODEX_POST_TOOL_TIMEOUT_SEC,
    ),
    // Hooks a session's own flags carry would otherwise wait for a person to review them in Codex's TUI, which nobody
    // here can open: the daemon wrote them, so they are trusted as written.
    bypass_hook_trust: true,
    });
    if (!planning) {
        config["hooks.Stop"] = hookOn("stop", { stop_hook_active: "${stop_hook_active}", key }, CODEX_STOP_TIMEOUT_SEC);
    }
    return config;
};

const PatchInputSchema = z.object({ command: z.string() });
const PATCH_HEADER = /^\*\*\* (Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gmu;

// The files one apply_patch touches, by what it does to each: added, changed (updated, or the target of a move), or
// deleted.
export interface PatchFiles {
    readonly added: string[];
    readonly changed: string[];
    readonly deleted: string[];
}

export const patchFiles = (input: PolicyInput): PatchFiles => {
    const files: PatchFiles = { added: [], changed: [], deleted: [] };
    const patch = PatchInputSchema.safeParse(input).data?.command ?? "";
    for (const [, op, path, moved] of patch.matchAll(PATCH_HEADER)) {
        if (moved !== undefined) {
            files.changed.push(moved.trim());
        } else if (op === "Add" && path !== undefined) {
            files.added.push(path.trim());
        } else if (op === "Delete" && path !== undefined) {
            files.deleted.push(path.trim());
        } else if (path !== undefined) {
            files.changed.push(path.trim());
        }
    }
    return files;
};

// Codex's own tools Claude Code has under another name, as the list spells them.
const CLAUDE_NAMES = new Map([
    ["list_mcp_resources", "ListMcpResourcesTool"],
    ["list_mcp_resource_templates", "ListMcpResourcesTool"],
    ["read_mcp_resource", "ReadMcpResourceTool"],
]);

/**
 * A Codex tool as the turn's tool list names it. apply_patch is the list's `Write` when it only adds files and `Edit`
 * otherwise; the shell is already `Bash` and an MCP tool already `mcp__server__tool`, as Claude Code spells them.
 */
export const codexListName = (call: Pick<GateCall, "tool" | "input">): string => {
    if (call.tool !== "apply_patch") {
        return CLAUDE_NAMES.get(call.tool) ?? call.tool;
    }
    const files = patchFiles(call.input);
    return files.added.length > 0 && files.changed.length === 0 && files.deleted.length === 0 ? "Write" : "Edit";
};

// A patch names its files in its own text; the persona's folder fence reads every one of them. Any other call's path is
// the gate's own to read off its input.
const codexPaths = (call: Pick<GateCall, "tool" | "input">): readonly string[] | undefined =>
    call.tool === "apply_patch" ? Object.values(patchFiles(call.input)).flat() : undefined;

// Whether the list names any shape of this tool: the tool itself, or the shell narrowed to some command.
const listsTool = (list: readonly string[], tool: string): boolean => list.some((entry) => entry.trim() === tool || entry.trim().startsWith(`${tool}(`));

// A server's tools as the list allows them: undefined for the whole server, else the names it lists one by one.
const serverTools = (list: readonly string[], server: string): readonly string[] | undefined => {
    if (toolAllowed(list, { name: `mcp__${server}__*` }) && list.some((entry) => [`mcp__${server}`, `mcp__${server}__*`].includes(entry.trim()))) {
        return undefined;
    }
    const prefix = `mcp__${server}__`;
    return list.flatMap((entry) => (entry.trim().startsWith(prefix) && !entry.includes("(") ? [entry.trim().slice(prefix.length)] : []));
};

/**
 * What a turn carrying a tool list turns off before Codex offers it, for the tools no hook sees: its hosted search and
 * pictures, its image viewer, its question tool, its own subagents (whose threads do not reach the gate: Codex leaves
 * their MCP servers unconnected, so their hooks fail and their calls run), and every MCP tool off the list. The gate's
 * own server stays whole: its tools are the hooks' way in.
 */
export const codexAllowlistConfig = (list: readonly string[] | undefined, servers: readonly string[]) => {
    // Codex's own subagents are off on every turn, list or not: their threads never reach the gate, so a child ran shell
    // and patches with no rulebook, no secret wrapper and no delegation caps (2026-10-25). A Codex turn delegates through
    // the daemon's `subagents` server instead, the gated door every other runtime uses.
    const config: CodexConfigLayer = {};
    config["features.multi_agent"] = false;
    if (list === undefined) {
        return config;
    }
    config["web_search"] = "disabled";
    config["features.image_generation"] = false;
    // Each of these is on by default and off unless the list names its tool.
    const offUnlisted = [
        ["Read", "features.view_image"],
        ["AskUserQuestion", "tools.experimental_request_user_input.enabled"],
        ["Bash", "features.shell_tool"],
    ] as const;
    for (const [tool, path] of offUnlisted) {
        if (!listsTool(list, tool)) {
            config[path] = false;
        }
    }
    for (const server of servers) {
        const tools = server === GATE_SERVER ? undefined : serverTools(list, server);
        if (tools !== undefined) {
            config[`mcp_servers.${server}.enabled_tools`] = [...tools];
        }
    }
    return config;
};

// What the gate answered one call, by Codex's call id.
export interface CodexGateRecord {
    readonly allowed: boolean;
    // Reaching the answer put a card in front of a person, so Codex's own approval request for it must not ask again.
    readonly asked: boolean;
    // The command as the model wrote it, where the one Codex runs is its wrapper.
    readonly said?: string;
}

export interface CodexHookSessionOptions {
    readonly cwd: string;
    readonly isolation?: TurnPlacement | undefined;
    readonly conversationId?: string | undefined;
    readonly tools: Pick<TurnTools, "secrets" | "cliEnv" | "heavyCommands" | "offloadCommands">;
    readonly editReviewers?: readonly EditReviewer[] | undefined;
    // Where the terminal frame goes the first time a command runs in the panel's session.
    readonly push: (event: AgentEvent) => void;
    // Whether shell commands run through the terminal panel's tmux wrapper; the image's own answer by default.
    readonly terminals?: boolean;
}

export interface CodexHookSession {
    // The secret the hook configuration carries; the gate refuses a call without it.
    readonly key: string;
    // What the loop attaches to the gate (turn-relay.ts).
    readonly gateHooks: GateHooks;
    readonly record: (id: string) => CodexGateRecord | undefined;
    readonly dispose: () => Promise<void>;
}

const CommandInputSchema = z.object({ command: z.string() }).loose();

/**
 * One Codex run's side of the gate: the key its hooks carry, the record of every answer, and the rewrite of a shell
 * command the rules let through (the terminal panel's wrapper, secret references, the masking wrapper).
 */
export const createCodexHookSession = (options: CodexHookSessionOptions): CodexHookSession => {
    const key = randomUUID();
    const records = new Map<string, CodexGateRecord>();
    // The one command runner every judged shell shares (shell-line.ts): Codex reads a command's output itself, so it is masked.
    const shell = createShellLines({
        tools: options.tools,
        isolation: options.isolation,
        owner: options.conversationId,
        terminals: options.terminals ?? tmuxRunEnabled(),
        mask: true,
        onPanel: (session) => options.push({ kind: "terminal", session }),
    });
    const shellRewrite = (command: string, call: GateCall): Promise<ShellLineOutcome> =>
        shell.line(command, { session: call.session, cwd: call.cwd ?? options.cwd, id: call.id }, AbortSignal.timeout(60_000));

    const settle = async (call: GateCall, policy: PolicyVerdict, asked: boolean): Promise<PolicyVerdict> => {
        const remember = (record: CodexGateRecord): void => void (call.id === undefined ? undefined : records.set(call.id, record));
        // The gate's own tools are offered to the model beside every other server's; they are the hooks' way in, not its.
        const verdict: PolicyVerdict = call.tool.startsWith(`mcp__${GATE_SERVER}__`) ? { decision: "deny", reason: NOT_A_HOOK } : policy;
        if (verdict.decision === "deny") {
            remember({ allowed: false, asked });
            return verdict;
        }
        const input = verdict.decision === "rewrite" ? verdict.input : call.input;
        const command = call.tool === "Bash" ? CommandInputSchema.safeParse(input).data?.command : undefined;
        if (command === undefined) {
            remember({ allowed: true, asked });
            return verdict;
        }
        const outcome = await shellRewrite(command, call);
        if ("refuse" in outcome) {
            remember({ allowed: false, asked });
            return { decision: "deny", reason: outcome.refuse };
        }
        remember({ allowed: true, asked, ...opt("said", outcome.command === command ? undefined : command) });
        if (outcome.command === command && verdict.decision === "allow") {
            return verdict;
        }
        const rewritten = { ...CommandInputSchema.parse(input), command: outcome.command };
        return verdict.context === undefined ? { decision: "rewrite", input: rewritten } : { decision: "rewrite", input: rewritten, context: verdict.context };
    };

    // The `file.edited` checks on each file a patch added or changed, in the paths the agent wrote, resolved where it ran.
    const afterTool = async (call: GateCall): Promise<string | undefined> => {
        const reviewers = options.editReviewers ?? [];
        if (call.tool !== "apply_patch" || reviewers.length === 0) {
            return undefined;
        }
        const files = patchFiles(call.input);
        const notes: string[] = [];
        for (const file of [...files.added, ...files.changed]) {
            for (const reviewer of reviewers) {
                // A check that cannot run is said, not swallowed: the model should not read silence as a clean file.
                const note = await reviewer(resolve(options.cwd, file), "this edit").catch(
                    (error: Parameters<typeof errorMessage>[0]) => `An edit check could not run on ${file}: ${errorMessage(error)}`,
                );
                if (note !== undefined && note !== "") {
                    notes.push(note);
                }
            }
        }
        return notes.length === 0 ? undefined : notes.join("\n\n");
    };

    return {
        key,
        gateHooks: {
            key,
            listName: codexListName,
            paths: codexPaths,
            settle,
            original: (call) => {
                const said = call.id === undefined ? undefined : records.get(call.id)?.said;
                return said === undefined ? undefined : { ...CommandInputSchema.parse(call.input), command: said };
            },
            afterTool,
        },
        record: (id) => records.get(id),
        dispose: () => shell.dispose(),
    };
};
