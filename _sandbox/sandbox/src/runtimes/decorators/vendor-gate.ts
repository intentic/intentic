import type { AgentRequest } from "../../agent/providers/agent-request.js";
import { opt } from "../../opt.js";
import { createTurnGate, type TurnGate } from "../../guard/turn-gate.js";

// The turn gate every vendor loop mints, read off the request's groups: the policy it judges by, the hooks that judge and
// record, and where the turn's commands run. The Claude Code loop builds its own, since only its hook can mark taint.
export const vendorTurnGate = ({ spec, policy, hooks, signal }: Pick<AgentRequest, "spec" | "policy" | "hooks" | "signal">): TurnGate =>
    createTurnGate({
        ...opt("safetyPolicy", policy.safetyPolicy),
        ...opt("judging", policy.judging),
        ...opt("unattended", policy.unattended),
        ...opt("outsideWake", policy.outsideWake),
        ...opt("rulebook", policy.rulebook),
        ...opt("judge", hooks.judge),
        ...opt("log", hooks.logSafety),
        ...opt("answered", hooks.safetyAnswered),
        ...opt("remember", hooks.rememberSafety),
        ...opt("conversationId", spec.conversationId),
        cwd: spec.cwd,
        ...opt("ownCheckout", spec.ownCheckout),
        signal,
        cards: hooks.cards,
    });
