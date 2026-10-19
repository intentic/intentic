import { computed, type ComputedRef } from "vue";
import { landFailure } from "../../agent-status/agentStatus-attention";
import { turnInFlight } from "../../agent-status/agentStatus-standing";
import { type CheckMarker, checksOf } from "../freshSession";
import { fleet, type FleetAgent } from "../useAgents-fleet";
import { cardProof, type ProofMark } from "./proofSeal";

// WHAT HAS LOOKED AT A CARD'S WORK, as one reading for the card (AgentCard): what its last turn showed of its own work
// (proofSeal.ts), and a marker per kind of check a fresh session ran on it since (freshSession.checksOf). Said in words on
// a line of its own (WorkAssurance.vue) wherever there is anything to say, and by the corner's seal alone only where
// that line is not drawn: on a fresh session's own card, which IS a check.

export interface WorkAssurance {
    readonly proof: ComputedRef<ProofMark | undefined>;
    readonly checks: ComputedRef<CheckMarker[]>;
    // Whether the card draws the line.
    readonly assured: ComputedRef<boolean>;
    // What the corner's seal wears: the proof, where no line says it.
    readonly seal: ComputedRef<ProofMark | undefined>;
}

export const useWorkAssurance = (agent: () => FleetAgent): WorkAssurance => {
    // Held while value-equal, so a roster frame that moved something else on the card (its activity, its clock) redraws
    // none of it. A land that broke wears no proof: a check mark on the card whose work is stuck read as finished.
    let heldPrint = ``;
    let heldProof: ProofMark | undefined;
    const proof = computed(() => {
        const card = agent();
        const next = landFailure(card) === undefined ? cardProof(card, turnInFlight(card)) : undefined;
        const print = JSON.stringify(next ?? null);
        if (print !== heldPrint) {
            heldPrint = print;
            heldProof = next;
        }
        return heldProof;
    });
    const checks = computed(() => checksOf(agent(), fleet.value));
    // Not while a turn is redoing the work, whose proof is not in yet.
    const assured = computed(() => agent().fresh === undefined && !turnInFlight(agent()) && (proof.value !== undefined || checks.value.length > 0));
    const seal = computed(() => (assured.value ? undefined : proof.value));
    return { proof, checks, assured, seal };
};
