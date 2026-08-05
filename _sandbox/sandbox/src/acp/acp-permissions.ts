import type { PermissionOption, PermissionOptionKind, RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";

/* The daemon's answer to ACP session/request_permission: auto-allow — the container is the isolation
 * boundary, the same posture as bypassPermissions / approvalPolicy:never / OpenCode allow-all. Per-tool
 * prompts are deliberately NOT surfaced to the user (the architecture's standing decision). The one nuance
 * is the plan phase: mutating tool kinds are rejected so the planning turn stays read-only — best-effort
 * (an agent that never asks isn't constrained), which the plan-emulation preamble also demands in prose. */

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

const MUTATING = new Set(["edit", "delete", "move", "execute"]);

export const decidePermission = (request: RequestPermissionRequest, phase: PermissionPhase, aborted: boolean): RequestPermissionResponse => {
    if (aborted) {
        return { outcome: { outcome: "cancelled" } };
    }
    if (phase === "plan" && typeof request.toolCall.kind === "string" && MUTATING.has(request.toolCall.kind)) {
        const rejection = pick(request.options, ["reject_once", "reject_always"]);
        if (rejection !== undefined) {
            return selected(rejection);
        }
        // No rejection offered — allowing beats cancelling the whole planning turn; the preamble still holds.
    }
    const allowance = pick(request.options, ["allow_always", "allow_once"]);
    if (allowance !== undefined) {
        return selected(allowance);
    }
    const first = request.options[0];
    return first !== undefined ? selected(first) : { outcome: { outcome: "cancelled" } };
};
