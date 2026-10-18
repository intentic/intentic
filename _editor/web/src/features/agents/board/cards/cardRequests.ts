import { messageOr } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, onScopeDispose, ref } from "vue";
import { landRequestWork, requestLandAgent } from "../../../../models/fleet/agentActions";
import { refreshAcross } from "../../../../models/sandbox/live/fleetAcross";
import { useAgents } from "../../../../models/fleet/useAgents";
import type { FleetAgent } from "../../../../models/fleet/useAgents-fleet";
import { useOperation } from "../../../../workbench/operations/operations";

// The two presses an agent card sends to the daemon itself rather than emitting to its host, since the board is only one
// of the card's several hosts: a collaborator's Request land, and Send again for a turn a spent allowance stranded.
// A refusal of either goes on the board's notice strip.
export const useCardRequests = (agent: () => FleetAgent, title: () => string) => {
    const t = useT();
    const { refresh: refreshAgents, notice: agentsNotice } = useAgents();
    // The ask is the card's, in the ledger, shared with its review page's press: either surface holds the other's. A
    // refusal goes on the board's notice strip, and to a reader who already left, as a receipt.
    const landRequest = useOperation(() => landRequestWork(agent().id, agent().sandboxId));
    const requesting = landRequest.busy;
    let present = true;
    onScopeDispose(() => {
        present = false;
    });
    const requestLand = async (): Promise<void> => {
        const { id, sandboxId } = agent();
        const name = title();
        const outcome = await landRequest.run({
            what: t(`agents.agentDetail.requestingLand`, { name }),
            done: () => t(`agents.agentDetail.landRequestSent`, { name }),
            failed: t(`agents.agentCard.couldntSendLandRequest`),
            task: async () => {
                await requestLandAgent(id, sandboxId);
                await (sandboxId === undefined ? refreshAgents() : Promise.resolve(refreshAcross()));
            },
        });
        // A card gone from the screen meanwhile left it to the receipt.
        if (present && outcome?.state === `failed`) {
            agentsNotice.value = outcome.failure?.detail ?? outcome.failure?.title;
            landRequest.dismiss();
        }
    };
    // The standing ask, worn for everyone: a collaborator sees it took, a maintainer reads it as the cue to land.
    const landAsk = computed(() => {
        const request = agent().landRequested;
        return request === undefined ? undefined : t(`agents.agentCard.askedToLand`, { name: request.name ?? request.email });
    });
    // Re-runs the exact held turn (useAgents.resumeHeldTurn), not a new message; a local flag, since `pending` names drop
    // actions and this is neither.
    // Cleared in `finally`, not only on success, since a roster frame is about to replace the card either way.
    const resending = ref(false);
    const sendAgain = async (): Promise<void> => {
        if (resending.value) {
            return;
        }
        resending.value = true;
        try {
            await useAgents().resumeHeldTurn(agent().id);
        } catch (caught) {
            // The card is left as it was and the words are still safe in the composer; the strip says why nothing moved.
            agentsNotice.value = messageOr(caught, t(`agents.agentCard.couldntSendAgain`));
        } finally {
            resending.value = false;
        }
    };
    return { requesting, requestLand, landAsk, resending, sendAgain };
};
