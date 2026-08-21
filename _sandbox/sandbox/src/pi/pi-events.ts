import type { AgentEvent, ToolCallContent } from "@intentic/sandbox-contract";
import { diffContent, displayNameOf, resultText, toolCategoryOf, toolLocations, toolTarget, workspacePath } from "../agent/tool-calls.js";

/* Pure mapping of Pi RPC events onto AgentEvent frames, the Pi-native producer of the contract's tool-call
 * vocabulary, the grok-agent streamTurn shape rebuilt for a pull-per-event transport. Events with no UI
 * mapping are dropped (the streamSdk philosophy). Stateful where the protocol is: tool args arrive on
 * `tool_execution_start` and the diff is derived at `_end`, so the mapper keeps them; usage arrives one
 * assistant message at a time and is summed into one frame at settle. */

// What a plan phase holds back instead of streaming: the assistant's text IS the plan. `errored` suppresses
// the plan frame, an error already streamed, so no plan may be proposed from partial output.
export interface PiTurnCapture {
    planText?: string;
    errored?: boolean;
}

export interface PiEventMapper {
    // One Pi event → its frames (usually 0 or 1; a tool result can carry a status and content together).
    readonly map: (event: Record<string, unknown>) => AgentEvent[];
    // The turn's summed usage frame, once, undefined when no assistant message reported any.
    readonly usage: () => AgentEvent | undefined;
    // What the turn held back, read at settle, the plan text of a `holdText` mapper, and whether an error
    // frame went out. Accumulated here rather than into a caller's object, exactly as `usage` is.
    readonly capture: () => PiTurnCapture;
}

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const num = (value: unknown): number => (typeof value === "number" ? value : 0);

/* Structured diffs derived from a Pi edit/write INPUT, known at call time, the authoritative content, in
 * Pi's OWN argument spelling: `edit` takes `{path, edits: [{oldText, newText}]}` (one call, many hunks, a
 * diff entry per hunk) and `write` takes `{path, content}`. The shared editDiffContent reads the Claude and
 * OpenCode spellings and would answer undefined for every Pi edit, downgrading each card to raw output.
 * Unrecognized shapes degrade to undefined (the card falls back to the tool's text output), never throw. */
const piEditDiffs = (name: string, args: unknown, cwd: string): ToolCallContent[] | undefined => {
    if (typeof args !== "object" || args === null) {
        return undefined;
    }
    const record = args as Record<string, unknown>;
    const rawPath = record["path"];
    if (typeof rawPath !== "string") {
        return undefined;
    }
    const path = workspacePath(rawPath, cwd) ?? rawPath;
    if (name === "Edit") {
        const edits = record["edits"];
        if (!Array.isArray(edits)) {
            return undefined;
        }
        const hunks = edits.flatMap((entry): ToolCallContent[] => {
            const edit = entry as Record<string, unknown>;
            const oldText = edit["oldText"];
            const newText = edit["newText"];
            return typeof oldText === "string" && typeof newText === "string" ? [diffContent(path, oldText, newText)] : [];
        });
        return hunks.length > 0 ? hunks : undefined;
    }
    if (name === "Write") {
        const content = record["content"];
        return typeof content === "string" ? [diffContent(path, undefined, content)] : undefined;
    }
    return undefined;
};

// `holdText` ⇒ plan phase: the assistant's text is accumulated into the capture instead of streamed, because
// that text IS the plan.
export const createPiEventMapper = (cwd: string, holdText = false): PiEventMapper => {
    // toolCallId → its (display) name and args from tool_execution_start, read back when the result lands.
    const calls = new Map<string, { name: string; args: unknown }>();
    const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 };
    let sawUsage = false;
    const capture: PiTurnCapture = {};

    const map = (event: Record<string, unknown>): AgentEvent[] => {
        switch (event["type"]) {
            case "message_update": {
                const delta = event["assistantMessageEvent"] as Record<string, unknown> | undefined;
                switch (delta?.["type"]) {
                    case "text_delta": {
                        const text = str(delta["delta"]) ?? "";
                        if (text === "") {
                            return [];
                        }
                        if (holdText) {
                            capture.planText = (capture.planText ?? "") + text;
                            return [];
                        }
                        return [{ kind: "delta", text }];
                    }
                    case "text_end":
                        // The prose block is finished, the client retires its bubble here (see the contract's
                        // text_end note). Meaningless while a plan phase is holding text back.
                        return holdText ? [] : [{ kind: "text_end" }];
                    case "thinking_delta": {
                        const text = str(delta["delta"]) ?? "";
                        return text === "" ? [] : [{ kind: "thinking", text }];
                    }
                    // toolcall_* deltas are argument streaming, the card renders from tool_execution_start.
                    default:
                        return [];
                }
            }
            case "message_end": {
                const message = event["message"] as Record<string, unknown> | undefined;
                if (message?.["role"] !== "assistant") {
                    return [];
                }
                const usage = message["usage"] as Record<string, unknown> | undefined;
                if (usage !== undefined) {
                    sawUsage = true;
                    totals.inputTokens += num(usage["input"]);
                    totals.outputTokens += num(usage["output"]);
                    totals.cacheReadTokens += num(usage["cacheRead"]);
                    totals.cacheCreationTokens += num(usage["cacheWrite"]);
                    totals.costUsd += num((usage["cost"] as Record<string, unknown> | undefined)?.["total"]);
                }
                if (message["stopReason"] === "error") {
                    capture.errored = true;
                    return [{ kind: "error", message: str(message["errorMessage"]) ?? "The model call failed." }];
                }
                return [];
            }
            case "tool_execution_start": {
                const id = str(event["toolCallId"]);
                if (id === undefined) {
                    return [];
                }
                const name = displayNameOf(str(event["toolName"]) ?? "tool");
                const args = event["args"];
                calls.set(id, { name, args });
                const target = toolTarget(args);
                const locations = toolLocations(args, cwd);
                return [
                    {
                        kind: "tool_call",
                        id,
                        name,
                        category: toolCategoryOf(name),
                        status: "in_progress",
                        ...(target !== undefined ? { target } : {}),
                        ...(locations !== undefined ? { locations } : {}),
                    },
                ];
            }
            case "tool_execution_update": {
                const id = str(event["toolCallId"]);
                if (id === undefined) {
                    return [];
                }
                // partialResult carries the ACCUMULATED output, snapshot semantics, which is exactly what the
                // frame's content REPLACE contract wants.
                const partial = resultText((event["partialResult"] as Record<string, unknown> | undefined)?.["content"]);
                return partial === "" ? [] : [{ kind: "tool_call_update", id, content: [{ type: "text", text: partial }] }];
            }
            case "tool_execution_end": {
                const id = str(event["toolCallId"]);
                if (id === undefined) {
                    return [];
                }
                const known = calls.get(id);
                const name = known?.name ?? displayNameOf(str(event["toolName"]) ?? "tool");
                const failed = event["isError"] === true;
                const output = resultText((event["result"] as Record<string, unknown> | undefined)?.["content"]);
                // An edit/write completion derives its diff from the (final) input, the authoritative content;
                // otherwise the tool's own text output (or error) is what the card shows.
                const diffs = failed ? undefined : piEditDiffs(name, known?.args, cwd);
                const content: ToolCallContent[] = diffs ?? [{ type: "text", text: output }];
                if (known === undefined) {
                    // A call first seen at its end (the start was missed) arrives as one whole tool_call,
                    // its args are gone with the start event, so the card is name + output alone.
                    return [{ kind: "tool_call", id, name, category: toolCategoryOf(name), status: failed ? "failed" : "completed", content }];
                }
                return [{ kind: "tool_call_update", id, status: failed ? "failed" : "completed", content }];
            }
            case "auto_retry_start": {
                // Pi is riding out a transient provider error inside the turn, the wait must be visible, with
                // its own next-attempt clock (the provider_retry frame's whole reason to exist).
                const delayMs = num(event["delayMs"]);
                return [
                    {
                        kind: "provider_retry",
                        attempt: num(event["attempt"]),
                        maxAttempts: num(event["maxAttempts"]),
                        ...(delayMs > 0 ? { nextAttemptAt: Date.now() + delayMs } : {}),
                    },
                ];
            }
            case "auto_retry_end": {
                if (event["success"] === true) {
                    return [];
                }
                capture.errored = true;
                return [{ kind: "error", message: str(event["finalError"]) ?? "The provider kept failing and Pi gave up retrying." }];
            }
            case "compaction_end": {
                const result = event["result"] as Record<string, unknown> | null | undefined;
                if (result === undefined || result === null) {
                    return []; // Aborted or failed compaction: nothing the transcript needs to say.
                }
                return [
                    {
                        kind: "compact",
                        trigger: str(event["reason"]) ?? "auto",
                        preTokens: num(result["tokensBefore"]),
                        postTokens: num(result["estimatedTokensAfter"]),
                    },
                ];
            }
            // agent_start/agent_end/turn_start/turn_end/message_start bracket what the frames above already
            // carry; queue_update mirrors our own steering queue; bash_execution_update only follows the direct
            // `bash` command this adapter never sends; extension UI is answered in pi-agent, not rendered.
            default:
                return [];
        }
    };

    return {
        map,
        usage: () => (sawUsage ? { kind: "usage", ...totals } : undefined),
        capture: () => capture,
    };
};
