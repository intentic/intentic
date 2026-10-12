import { type AgentTurn, type ModelPin, withRuntimeDefaults } from "@intentic/sandbox-contract";
import type { Services } from "../../../composition.js";
import { opt } from "../../../opt.js";
import type { RoutedTurn } from "../../../seams/turn-starter.js";
import { personaRunModel, runRoleModel, unpinnedRunProvider } from "../../models/run-role-model.js";
import { sessionFor } from "../../providers/accounts/routing.js";

// Which provider, model and loop a turn runs on, decided once for every turn the daemon starts, whichever door it comes
// through (turn-doors.ts: `start`, `run`, `stream`). Resolved before the turn is journaled, so a restart keeps the model
// it started on rather than a changed setting. The persona's ladder is asked before the role's; if neither answers, the
// turn keeps no pin.

// Each knob fills only where the turn is silent about it, since these can arrive independently of the model (a surface
// may pin effort but leave the model to the setting). One table, so this list and the settings-row footer agree.
const PIN_KNOBS = ["effort", "thinking", "fast", "harness"] as const;

const pinnedKnobs = (turn: AgentTurn, pin: ModelPin): Partial<AgentTurn> =>
    Object.fromEntries(
        PIN_KNOBS.filter((knob) => turn[knob] === undefined && pin[knob] !== undefined && pin[knob] !== "").map((knob) => [knob, pin[knob]]),
    );

// The pin answers for a turn nobody picked a model for, whoever is watching it: `runRole` and `actsAs` are the only
// things that can answer, so an ordinary chat carrying neither is left alone by that alone. Whether anyone is watching
// (`unattended`) is a separate question and not one this pin may read.
const withRoleModel = async <T extends AgentTurn>(services: Services, turn: T): Promise<T> => {
    // Naming either model or agent already answers this: the pin carries a provider with its model, so filling over a
    // chosen agent would move it to a different provider (breaking an intentional cross-provider race). This is also what
    // keeps a turn that walked its own ladder (an automation's fire, a runner's dispatched turn) on the rung it chose.
    if (turn.model !== undefined || turn.agent !== undefined) {
        return turn;
    }
    const pinned =
        (await personaRunModel(services, turn.actsAs)) ?? (turn.runRole === undefined ? undefined : await runRoleModel(services, turn.runRole));
    if (pinned === undefined) {
        // A job the sandbox started with no pin runs on a provider that can serve it, never on one nobody connected.
        const fallback = turn.runRole === undefined ? undefined : await unpinnedRunProvider(services);
        return fallback === undefined ? turn : { ...turn, agent: fallback };
    }
    // The pin's provider must travel with its model: a model id is only meaningful to the provider that vends it.
    return { ...turn, agent: pinned.provider, model: pinned.model, ...pinnedKnobs(turn, pinned) };
};

// The one preamble every door applies as a turn comes in: the persona or run role has the chance to name the provider,
// model and knobs, then whatever is still unnamed takes the wire's defaults (withRuntimeDefaults). Idempotent, so a door
// downstream of another may route again.
export const routeTurn = async <T extends AgentTurn>(services: Services, sent: T) => withRuntimeDefaults(await withRoleModel(services, sent));

// The turn on the session its conversation continues, judged on the routing it was just given (sessionFor): a pinned model
// can move a turn to another provider than the one its caller built it for, and the session minted elsewhere is no use there.
export const onItsSession = (
    services: Pick<Services, "agents" | "conversations">,
    routed: RoutedTurn & { readonly conversationId: string },
): RoutedTurn & { readonly conversationId: string } => {
    const { sessionId: named, ...rest } = routed;
    return { ...rest, ...opt("sessionId", sessionFor(services, { ...routed, sessionId: named })) };
};
