import { computed, type ComputedRef } from "vue";
import { landFailure } from "../../agent-status/agentStatus-attention";
import { turnInFlight } from "../../agent-status/agentStatus-standing";
import { checksOf } from "../freshSession";
import { fleet, type FleetAgent } from "../useAgents-fleet";
import { cardProof } from "./proofSeal";
import { type Stamp, stampsOf } from "./stamps";

// WHAT VOUCHES FOR A CARD'S WORK, as the stamps in its corner (stamps.ts, CardStamps.vue): what its last turn checked
// of its own work (proofSeal.ts), then the latest check of each kind a fresh session ran on it (freshSession.checksOf).

// One card's stamps, for the board's card and the rail's row alike. Nothing while a turn is redoing the work, since the
// stamps are about the work as it was. A land that broke carries no proof either: a passing stamp on a card whose work
// is stuck reads as finished.
export const cardStampsOf = (card: FleetAgent, all: readonly FleetAgent[]): Stamp[] =>
    turnInFlight(card) ? [] : stampsOf(landFailure(card) === undefined ? cardProof(card, false) : undefined, checksOf(card, all));

// Held while value-equal, so a roster frame that moved something else on the card (its activity, its clock) redraws
// none of it.
export const useCardStamps = (agent: () => FleetAgent): ComputedRef<Stamp[]> => {
    let heldPrint = ``;
    let held: Stamp[] = [];
    return computed(() => {
        const next = cardStampsOf(agent(), fleet.value);
        const print = JSON.stringify(next);
        if (print !== heldPrint) {
            heldPrint = print;
            held = next;
        }
        return held;
    });
};
