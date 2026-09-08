import type { PermissionOption, PermissionOptionKind, RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { type CommandGate, consultWith, vendorSubject } from "../../guard/command-gate.js";

// Daemon's answer to ACP session/request_permission: auto-allows by default. Plan phase rejects mutating tool kinds
// (best-effort); the safety policy runs the same triage/judge/hard rule as the Claude Code hook. A refusal carries no
// reason; the card shows the user why, the agent only sees rejected.

export type PermissionPhase = "execute" | "plan";

const pick = (options: readonly PermissionOption[], kinds: readonly PermissionOptionKind[]): PermissionOption | undefined => {
    for (const kind of kinds) {
        const match = options.find((option) => option.kind === kind);
        if (match !== undefined) {
            return match;
        }
    }
    return undefined;
};

const selected = (option: PermissionOption): RequestPermissionResponse => ({ outcome: { outcome: "selected", optionId: option.optionId } });
const CANCELLED: RequestPermissionResponse = { outcome: { outcome: "cancelled" } };

const MUTATING = new Set(["edit", "delete", "move", "execute"]);

// Text the classifier can read from a call, or undefined if none; rawInput's shape is the agent's, so common field
// names are tried in turn before falling back to title. Never throws on a hostile rawInput shape.
const programOf = (request: RequestPermissionRequest): string | undefined => {
    const raw = request.toolCall.rawInput;
    if (typeof raw === "object" && raw !== null) {
        for (const key of ["command", "cmd", "script", "code", "input"]) {
            const value = (raw as Record<string, unknown>)[key];
            if (typeof value === "string" && value.trim() !== "") {
                return value;
            }
        }
    }
    const title = request.toolCall.title;
    return typeof title === "string" && title.trim() !== "" ? title : undefined;
};

export const decidePermission = async (
    request: RequestPermissionRequest,
    phase: PermissionPhase,
    aborted: boolean,
    gate?: CommandGate,
    // Permission arrives via the connection's callback, not the turn generator; frames push into the turn's queue.
    push: (event: AgentEvent) => void = () => {},
): Promise<RequestPermissionResponse> => {
    if (aborted) {
        return CANCELLED;
    }
    const rejection = pick(request.options, ["reject_once", "reject_always"]);
    if (phase === "plan" && typeof request.toolCall.kind === "string" && MUTATING.has(request.toolCall.kind)) {
        if (rejection !== undefined) {
            return selected(rejection);
        }
        // No rejection offered, allowing beats cancelling the whole planning turn; the preamble still holds.
    }
    // The rulebook is consulted only when the owner wrote a rule, the agent offered a way to say no, and the call
    // carries readable text; missing any of the three, this is the auto-allow it always was.
    if (gate?.enforcing === true && rejection !== undefined) {
        const program = programOf(request);
        if (program !== undefined) {
            const outcome = await consultWith(gate, program, vendorSubject(request.toolCall.name ?? request.toolCall.kind ?? "tool"), push);
            if (!outcome.allow) {
                return selected(rejection);
            }
        }
    }
    const allowance = pick(request.options, ["allow_always", "allow_once"]);
    if (allowance !== undefined) {
        return selected(allowance);
    }
    const first = request.options[0];
    return first !== undefined ? selected(first) : CANCELLED;
};
