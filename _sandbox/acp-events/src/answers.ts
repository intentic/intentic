import type { PermissionOption, PermissionOptionKind, RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk/unstable";

// An answer to ACP's session/request_permission, as one of the options the agent offered: the protocol fixes the kinds
// an option may be, never which of them an agent offers, so every answer is a pick among what is there. Who decides (a
// rulebook, a card, a person at a computer) is each caller's own; this is how the decision is said to the agent.

// A person's answer to one call, from the permission card a turn raises.
export type PersonDecision = "once" | "always" | "deny";

// The first option of the first kind on offer, in the order the kinds are named.
export const pickOption = (options: readonly PermissionOption[], kinds: readonly PermissionOptionKind[]): PermissionOption | undefined => {
    for (const kind of kinds) {
        const match = options.find((option) => option.kind === kind);
        if (match !== undefined) {
            return match;
        }
    }
    return undefined;
};

export const selectedOption = (option: PermissionOption): RequestPermissionResponse => ({ outcome: { outcome: "selected", optionId: option.optionId } });

// The answer that picks nothing, which the agent reads as the turn stopping.
export const CANCELLED: RequestPermissionResponse = { outcome: { outcome: "cancelled" } };

// Whether an answer let the call run.
export const allowedBy = (request: RequestPermissionRequest, response: RequestPermissionResponse): boolean => {
    const { outcome } = response;
    if (outcome.outcome !== "selected") {
        return false;
    }
    const kind = request.options.find((option) => option.optionId === outcome.optionId)?.kind;
    return kind === "allow_once" || kind === "allow_always";
};

// A person's decision as one of the options the agent offered. Without a no on offer a deny is a cancel, which the
// agent reads as the turn stopping: the person said no, and nothing else here would make it hold.
export const personAnswer = (request: RequestPermissionRequest, decision: PersonDecision): RequestPermissionResponse => {
    const kinds: readonly PermissionOptionKind[] =
        decision === "deny" ? ["reject_once", "reject_always"] : decision === "always" ? ["allow_always", "allow_once"] : ["allow_once", "allow_always"];
    const option = pickOption(request.options, kinds);
    return option === undefined ? CANCELLED : selectedOption(option);
};

// The answer that lets nothing through and asks nobody: a no where one is on offer, else a cancel, which ends the
// request rather than letting the call run.
export const refusePermission = (request: RequestPermissionRequest): RequestPermissionResponse => {
    const rejection = pickOption(request.options, ["reject_once", "reject_always"]);
    return rejection === undefined ? CANCELLED : selectedOption(rejection);
};
