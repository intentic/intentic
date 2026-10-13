import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { toolAnnotations } from "@intentic/sandbox-contract/peer-mcp-server";
import { z } from "zod";
import { type TurnChecks, turnCheckReports, turnChecksNote } from "../../agent/run/turn-checks.js";
import { sdk } from "../../engines/claude-sdk.js";
import { sealOutside } from "../../guard/outside-results.js";
import { consultPolicy, guardFailed, type PolicyInput, type PolicyTurn, type PolicyVerdict } from "./policy-gate.js";

// The policy gate (policy-gate.ts) as an MCP server a turn mounts on the daemon's door, for a runtime whose own hooks can
// call an MCP tool (Codex's per-thread `hooks` with an `mcp_tool` handler): `pre_tool_use` before a tool runs,
// `post_tool_use` after it, `stop` as the turn is about to end. Each answers hook-decision JSON in the subset Codex's
// hook parser accepts (codex-rs/hooks output_parser.rs), which Claude Code's hooks read the same way: no
// `permissionDecision: "allow"` without an `updatedInput`, no rewritten tool output (Codex refuses both, and a refused
// answer is a failed hook, which Codex lets through). The turn is the server's own: one instance per turn's lease, so
// nothing in a call can name another turn, and a call before the loop attached its gate is refused (fail closed).

export const GATE_SERVER = "gate";

// One call as the runtime's hook hands it over.
export interface GateCall {
    // The tool as the runtime names it (Codex's `Bash`, `apply_patch`, `mcp__server__tool`).
    readonly tool: string;
    readonly input: PolicyInput;
    readonly cwd?: string | undefined;
    // The runtime's id for the call (Codex's call id, which is also its item id), when the hook passes one.
    readonly id?: string | undefined;
    // The runtime's session the call belongs to (Codex's thread id), when the hook passes one.
    readonly session?: string | undefined;
}

// What the loop adds to the gate once it runs (turn-relay.ts `gateHooks`), each optional.
export interface GateHooks {
    // The secret the loop wrote into its hook configuration. The gate's tools are visible to the model as well; a call
    // that does not carry the key is the model calling them itself, and is refused rather than read as a hook.
    readonly key?: string;
    // The tool's name as the turn's tool list spells it (Codex's `apply_patch` is the list's `Edit` or `Write`).
    readonly listName?: (call: GateCall) => string;
    // Runs after the policy answered, on its verdict: the loop's own rewrite of a call the rules let through (its shell
    // wrapper, a secret resolved), and its record of what was answered. `asked` says a card went to a person on the way.
    readonly settle?: (call: GateCall, verdict: PolicyVerdict, asked: boolean) => Promise<PolicyVerdict>;
    // The input the model wrote, for a call `settle` rewrote: what the taint classifier reads after the call ran, since the
    // runtime hands back the rewritten one.
    readonly original?: (call: GateCall) => PolicyInput | undefined;
    // After a tool ran: what the model should read about it (an edit check's findings), or undefined.
    readonly afterTool?: (call: GateCall) => Promise<string | undefined>;
}

export interface GateServerDeps {
    // The turn as the policy reads it, late-bound: undefined until the loop attaches its gate (turn-relay.ts).
    readonly turn: () => PolicyTurn | undefined;
    // Marks the turn's taint bit when a result brought outside content in.
    readonly mark: (source: string) => void;
    // The repositories' `turn` checks bound to this turn (harness-hooks.ts turnChecksOf); absent runs none at stop.
    readonly turnChecks?: TurnChecks | undefined;
    // The loop's additions, late-bound like `turn`.
    readonly hooks?: () => GateHooks | undefined;
}

// The hook decision these tools answer.
export interface HookDecision {
    readonly decision?: "block";
    readonly reason?: string;
    readonly hookSpecificOutput?: {
        readonly hookEventName: "PreToolUse" | "PostToolUse" | "Stop";
        readonly permissionDecision?: "allow" | "deny";
        readonly permissionDecisionReason?: string;
        readonly updatedInput?: PolicyInput;
        readonly additionalContext?: string;
    };
}

const json = (value: HookDecision) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

// A verdict as a PreToolUse hook's answer. An allow carries no decision: the call simply goes ahead, with any note.
export const preToolUseAnswer = (verdict: PolicyVerdict): HookDecision => {
    if (verdict.decision === "deny") {
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: verdict.reason } };
    }
    const context = verdict.context === undefined ? {} : { additionalContext: verdict.context };
    if (verdict.decision === "rewrite") {
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: verdict.input, ...context } };
    }
    return verdict.context === undefined ? {} : { hookSpecificOutput: { hookEventName: "PreToolUse", ...context } };
};

export const NOT_A_HOOK =
    "This tool is the sandbox's own safety seam, called by the runtime before and after each of your tools; it is not for you to call. Carry on with your task.";

// Whether a permission card went out while `run` waited on the policy, through the turn's own push.
const noticingCards = async (turn: PolicyTurn | undefined, run: (turn: PolicyTurn | undefined) => Promise<PolicyVerdict>): Promise<{ verdict: PolicyVerdict; asked: boolean }> => {
    let asked = false;
    const watched =
        turn === undefined
            ? undefined
            : {
                  ...turn,
                  push: (event: AgentEvent) => {
                      asked ||= event.kind === "permission";
                      turn.push(event);
                  },
              };
    const verdict = await run(watched);
    return { verdict, asked };
};

export const gateServer = (deps: GateServerDeps): McpSdkServerConfigWithInstance => {
    // Once per turn, whatever was found: a second stop is the model's answer to the first (turn-checks.ts).
    let stopped = false;
    // A call without the loop's key is the model's own; with no loop attached yet there is no key to hold it to.
    const keyed = (key: string | undefined): boolean => {
        const expected = deps.hooks?.()?.key;
        return expected === undefined || key === expected;
    };
    const keyField = z.string().optional().describe("Set by the runtime's hook configuration");
    return sdk().createSdkMcpServer({
        name: GATE_SERVER,
        tools: [
            sdk().tool(
                "pre_tool_use",
                "The sandbox's policy, asked by the runtime before each tool runs. Not for the model to call.",
                {
                    tool_name: z.string().describe("The tool about to run, as the runtime names it"),
                    tool_input: z.unknown().describe("Its input"),
                    cwd: z.string().optional().describe("Where it runs, when known"),
                    tool_use_id: z.string().optional().describe("The runtime's id for the call"),
                    session_id: z.string().optional().describe("The runtime's session id"),
                    key: keyField,
                },
                async ({ tool_name, tool_input, cwd, tool_use_id, session_id, key }) => {
                    if (!keyed(key)) {
                        return json(preToolUseAnswer({ decision: "deny", reason: NOT_A_HOOK }));
                    }
                    // Never an error result: Codex reads a failed hook as no objection and runs the call.
                    try {
                        const hooks = deps.hooks?.();
                        const call: GateCall = { tool: tool_name, input: tool_input, cwd, id: tool_use_id, session: session_id };
                        const tool = hooks?.listName?.(call) ?? tool_name;
                        const { verdict, asked } = await noticingCards(deps.turn(), (turn) => consultPolicy(turn, { tool, input: tool_input, cwd }));
                        const settled = hooks?.settle === undefined ? verdict : await hooks.settle(call, verdict, asked);
                        return json(preToolUseAnswer(settled));
                    } catch (error) {
                        return json(preToolUseAnswer({ decision: "deny", reason: guardFailed(error) }));
                    }
                },
                // A held call parks on a card and its answer decides whether a write happens.
                { annotations: toolAnnotations("write") },
            ),
            sdk().tool(
                "post_tool_use",
                "Tells the sandbox what a tool returned, asked by the runtime after each tool. Not for the model to call.",
                {
                    tool_name: z.string(),
                    tool_input: z.unknown(),
                    tool_response: z.unknown(),
                    tool_use_id: z.string().optional(),
                    key: keyField,
                },
                async ({ tool_name, tool_input, tool_response, tool_use_id, key }) => {
                    if (!keyed(key)) {
                        return json({});
                    }
                    try {
                        // Only the mark: a door server's result was already sealed at the door, and Codex takes no
                        // rewritten output from a hook, so content from outside sets the turn's taint bit and no more.
                        const hooks = deps.hooks?.();
                        const ran: GateCall = { tool: tool_name, input: tool_input, id: tool_use_id };
                        const call = { ...ran, input: hooks?.original?.(ran) ?? tool_input };
                        sealOutside(tool_name, call.input, tool_response, deps.mark);
                        const note = await hooks?.afterTool?.(call);
                        return json(note === undefined ? {} : { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: note } });
                    } catch {
                        // What could not be read is read as outside content: the safe direction for the taint bit.
                        deps.mark(tool_name);
                        return json({});
                    }
                },
                // Only ever sets the turn's taint bit, the safe direction.
                { annotations: toolAnnotations("write") },
            ),
            sdk().tool(
                "stop",
                "Asked by the runtime as the turn is about to end: runs the checks the repositories this turn changed declare for that moment, once. Not for the model to call.",
                { stop_hook_active: z.boolean().optional(), key: keyField },
                async ({ stop_hook_active, key }) => {
                    const checks = deps.turnChecks;
                    if (!keyed(key) || checks === undefined || stopped || stop_hook_active === true) {
                        return json({});
                    }
                    stopped = true;
                    try {
                        const reports = await turnCheckReports(checks);
                        if (reports.length === 0) {
                            return json({});
                        }
                        // `block` is how a Stop hook hands the model something to read before it ends: said once.
                        return json({ decision: "block", reason: turnChecksNote(reports) });
                    } catch (error) {
                        // Never a failed stop: a check that cannot be run is no reason to keep the turn from ending.
                        checks.logger.warn({ err: error }, "turn checks: could not run the repositories' turn checks, so the turn ends without them");
                        return json({});
                    }
                },
                { annotations: toolAnnotations("read") },
            ),
        ],
    });
};
