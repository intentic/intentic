import type { AgentRequest } from "../../agent/providers/agent-request.js";
import { opt } from "../../opt.js";
import { createTurnGate, type TurnGate } from "../../guard/turn-gate.js";
import type { RelaySink } from "../daemon-tools/turn-relay.js";

// The turn gate every vendor loop mints, read off the request's groups: the policy it judges by, the hooks that judge and
// record, and where the turn's commands run. The Claude Code loop builds its own, since only its hook can mark taint.
// Releasing it also ends the gate's signal: an agent can end its turn with an ask still unanswered (its process died, or
// it moved on), and the card that ask raised must not stay open on nobody. `sink`, for a loop that attaches nothing else
// to the turn's relay (turn-relay.ts), attaches it with this gate, until the release takes both back.
export const vendorTurnGate = (
    { spec, policy, hooks, signal }: Pick<AgentRequest, "spec" | "policy" | "hooks" | "signal">,
    sink?: Omit<RelaySink, "guard">,
): TurnGate => {
    const ended = new AbortController();
    const turn = createTurnGate({
        ...opt("safetyPolicy", policy.safetyPolicy),
        ...opt("judging", policy.judging),
        ...opt("unattended", policy.unattended),
        ...opt("outsideWake", policy.outsideWake),
        ...opt("rulebook", policy.rulebook),
        ...opt("actionRules", policy.actionRules),
        ...opt("judge", hooks.judge),
        ...opt("log", hooks.logSafety),
        ...opt("answered", hooks.safetyAnswered),
        ...opt("remember", hooks.rememberSafety),
        ...opt("rememberFailed", hooks.rememberSafetyFailed),
        ...opt("steered", hooks.steered),
        ...opt("installs", hooks.projectInstalls),
        ...opt("onImageInstall", hooks.onImageInstall),
        ...opt("conversationId", spec.conversationId),
        cwd: spec.cwd,
        ...opt("ownCheckout", spec.ownCheckout),
        signal: AbortSignal.any([signal, ended.signal]),
        cards: hooks.cards,
    });
    const detach = sink === undefined ? undefined : hooks.relay?.attach({ ...sink, guard: { gate: turn.gate, taint: turn.taint } });
    return {
        ...turn,
        release: () => {
            detach?.();
            ended.abort();
            turn.release();
        },
    };
};
