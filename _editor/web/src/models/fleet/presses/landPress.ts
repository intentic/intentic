import type { LandedRemover } from "@intentic/sandbox-contract/schemas/agents";
import { messageOr } from "@intentic/ui/async";
import { t } from "@intentic/ui/i18n";
import { useNotifications } from "../../../workbench/notifications/notifications";
import { refreshAcross } from "../../sandbox/live/fleetAcross";
import { invalidateAgentAction, landAgent, nothingLanded } from "../agentActions";
import { useAgents } from "../useAgents";
import type { FleetAgent } from "../useAgents-fleet";
import { hold, pendingOn } from "../useAgents-provisional";

// A land a person presses by hand, from whichever surface offers it: the board card's Land now and Land again, the
// card's menu, and the chat list's menu for the same agent. One runner, so each says a refusal and an empty land the
// same way.

// Land now takes what the workspace does not hold yet; Land again puts back the whole output after some of it left.
export type LandChoice = `land` | `reland`;

// Whether the agent offers Land again: landed work left the workspace, and not by another agent's own doing, since an
// orchestrator tidying away a reviewer's patches did that on purpose (agentStatus-land.landedAway says so on the card).
export const offersReland = (agent: { readonly landedPresence?: { readonly removedBy?: LandedRemover } }): boolean =>
    agent.landedPresence !== undefined && agent.landedPresence.removedBy?.kind !== `agent`;

/** Lands the agent's work and re-reads it; answers the refusal to say, or undefined when it went (an empty land says so). */
export const landByHand = async (id: string, chosen: LandChoice, at: string | undefined): Promise<string | undefined> => {
    const result = await landAgent(id, `check`, chosen === `reland` ? `cumulative` : `outstanding`, false, at);
    await invalidateAgentAction(id, at);
    if (!result.landed) {
        // A first refusal with a report to read, not a repeat.
        return t(`agents.useAgentDrag.landingHitConflict`);
    }
    if (!result.changed) {
        // Merged with nothing to show for it. The card carries no trace of that either way, so an unsaid one leaves the
        // press looking like it worked; a receipt, since nothing was refused.
        useNotifications().say(nothingLanded());
    }
    return undefined;
};

/**
 * The same land from a menu drawn away from the board (the chat list's), where no board strip is there to carry a
 * refusal: it is said as a warning toast instead. Holds the card for the press as the board's own runner does
 * (useAgentDrag.perform), so a second press on a card already landing does nothing.
 */
export const landFromMenu = async (agent: Pick<FleetAgent, `id` | `sandboxId`>, chosen: LandChoice): Promise<void> => {
    const { id, sandboxId: at } = agent;
    if (pendingOn(id, at) !== undefined) {
        return;
    }
    const lift = hold(id, at, { action: chosen });
    const { warn } = useNotifications();
    try {
        const refused = await landByHand(id, chosen, at);
        if (refused !== undefined) {
            warn(refused);
        }
        await (at === undefined ? useAgents().refresh() : Promise.resolve(refreshAcross()));
    } catch (caught) {
        warn(messageOr(caught, t(`agents.useAgentDrag.didntWork`)));
    } finally {
        lift();
    }
};
