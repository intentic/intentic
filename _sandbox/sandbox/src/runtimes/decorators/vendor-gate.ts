import type { AgentRequest } from "../../agent/providers/agent-request.js";
import { opt } from "../../opt.js";
import { createTurnGate, type TurnGate } from "../../guard/turn-gate.js";

// The turn gate every vendor loop mints, read off the request's groups: the policy it judges by, the hooks that judge and
// record, and where the turn's commands run. The Claude Code loop builds its own, since only its hook can mark taint.
// Releasing it also ends the gate's signal: an agent can end its turn with an ask still unanswered (its process died, or
// it moved on), and the card that ask raised must not stay open on nobody.
export const vendorTurnGate = ({ spec, policy, hooks, signal }: Pick<AgentRequest, "spec" | "policy" | "hooks" | "signal">): TurnGate => {
    const ended = new AbortController();
    const turn = createTurnGate({
        ...opt("safetyPolicy", policy.safetyPolicy),
        ...opt("judging", policy.judging),
        ...opt("unattended", policy.unattended),
        ...opt("outsideWake", policy.outsideWake),
        ...opt("rulebook", policy.rulebook),
        ...opt("judge", hooks.judge),
        ...opt("log", hooks.logSafety),
        ...opt("answered", hooks.safetyAnswered),
        ...opt("remember", hooks.rememberSafety),
        ...opt("steered", hooks.steered),
        ...opt("installs", hooks.projectInstalls),
        ...opt("onImageInstall", hooks.onImageInstall),
        ...opt("conversationId", spec.conversationId),
        cwd: spec.cwd,
        ...opt("ownCheckout", spec.ownCheckout),
        signal: AbortSignal.any([signal, ended.signal]),
        cards: hooks.cards,
    });
    return {
        ...turn,
        release: () => {
            ended.abort();
            turn.release();
        },
    };
};
