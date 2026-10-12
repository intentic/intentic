import type { PermissionOption, PermissionOptionKind, RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import type { AgentEvent } from "@intentic/sandbox-contract";
import type { CommandGuard } from "../../guard/command-guard.js";
import { answerVendorAsk, askCwdOf, askProgramOf, VendorToolInputSchema } from "../decorators/vendor-ask.js";

// Daemon's answer to ACP session/request_permission: auto-allows by default. Plan phase rejects mutating tool kinds
// (best-effort); the safety policy runs the same triage/judge/hard rule as the Claude Code hook, through the answer
// every vendor ask shares (decorators/vendor-ask.ts). A refusal carries no reason; the card shows the user why, the
// agent only sees rejected.

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

export const decidePermission = async (
    request: RequestPermissionRequest,
    phase: PermissionPhase,
    aborted: boolean,
    gate?: CommandGuard,
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
    // rawInput's shape is the agent's; the title stands in when it names no command. No cwd to read it against: the
    // gate already carries the turn's.
    const input = VendorToolInputSchema.parse(request.toolCall.rawInput);
    const answer = await answerVendorAsk(gate === undefined ? undefined : { gate, push }, {
        tool: request.toolCall.name ?? request.toolCall.kind ?? "tool",
        program: askProgramOf(input, request.toolCall.title),
        cwd: askCwdOf(input),
        canRefuse: rejection !== undefined,
    });
    // The standing "always" only while no rule is watching: once the rulebook enforces, the agent must keep asking.
    const lasting = answer.allow && answer.lasting;
    const allowance = answer.allow ? pick(request.options, lasting ? ["allow_always", "allow_once"] : ["allow_once"]) : undefined;
    if (allowance !== undefined) {
        return selected(allowance);
    }
    // A refusal, or no one-time yes on offer while the rulebook enforces: an "always" would let the agent run later
    // commands without asking, past the rulebook. Without a no on offer the rulebook was never consulted and cannot
    // hold this agent's calls anyway, and cancelling would end the whole turn.
    if (!lasting && rejection !== undefined) {
        return selected(rejection);
    }
    const first = request.options[0];
    return first !== undefined ? selected(first) : CANCELLED;
};
