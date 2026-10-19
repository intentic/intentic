import type { TurnProof } from "@intentic/sandbox-contract/schemas/agents";

// WHAT A CARD'S LAST TURN SHOWED OF ITS OWN WORK (AgentSummary.proof, read off the checks the turn chose to run after
// its last edit), trimmed to what the card can say. Pure functions over plain data, no store, no Vue, like
// agentStatus-standing.ts. The card says it as its self-check stamp (stamps.ts), so a rail row and a board card read
// one projection and cannot disagree about it.

export type ProofVerification = Exclude<TurnProof[`verification`], `no-code`>;

// The last turn's own evidence, trimmed to what earns a mark: a turn that changed nothing a check could speak to says
// nothing, and neither does one that looked at every interface file it changed.
export interface ProofMark {
    readonly verification?: ProofVerification;
    // The command that spoke, so a targeted test is never read as the whole suite.
    readonly check?: string;
    // Rendered files it changed without looking at the result.
    readonly unviewed?: number;
}

export const proofMark = (proof: TurnProof | undefined): ProofMark | undefined => {
    if (proof === undefined) {
        return undefined;
    }
    const verification = proof.verification === `no-code` ? undefined : proof.verification;
    const unviewed = proof.unviewed !== undefined && proof.unviewed > 0 ? proof.unviewed : undefined;
    if (verification === undefined && unviewed === undefined) {
        return undefined;
    }
    return {
        ...(verification === undefined ? {} : { verification }),
        ...(verification === undefined || proof.check === undefined ? {} : { check: proof.check }),
        ...(unviewed === undefined ? {} : { unviewed }),
    };
};

// The proof one card wears. It is the LAST turn's, so a turn under way hides it rather than wear an answer about work it
// is already redoing.
export const cardProof = (agent: { readonly proof?: TurnProof }, working: boolean): ProofMark | undefined =>
    working ? undefined : proofMark(agent.proof);
