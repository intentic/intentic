import type { TurnProof } from "@intentic/sandbox-contract";

// WHAT A CARD SAYS ABOUT ITS WORK NOW THAT NOTHING CHECKS IT FOR THE CONVERSATION: what its last turn showed of its own
// work (AgentSummary.proof, read off the checks the turn chose to run after its last edit). Pure functions over plain
// data, no store, no Vue, like agentStatus.ts: the words belong to the mark that draws these (CardSeal.vue), so a rail
// row and a board card read one projection and cannot disagree about it.

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

// ONE MARK FOR THE WHOLE READING: the card's seal (CardSeal.vue). A reader learns three shapes instead of reading up to
// two phrases on every finished card: its own last check failed, or the work is done and nothing proved it (no check
// after the last edit, or an interface changed unseen), or everything it showed passed.
export type SealKind = `broke` | `open` | `closed`;

export const sealOf = (proof: ProofMark): SealKind => {
    if (proof.verification === `failing`) {
        return `broke`;
    }
    return proof.verification === `unproven` || proof.unviewed !== undefined ? `open` : `closed`;
};

// The proof one card wears. It is the LAST turn's, so a turn under way hides it rather than wear an answer about work it
// is already redoing.
export const cardProof = (agent: { readonly proof?: TurnProof }, working: boolean): ProofMark | undefined =>
    working ? undefined : proofMark(agent.proof);

// THE SEAL STANDS IN for a resting glyph (landed's octagon, which it is when closed, and idle's dot), since those say
// only that nothing is going on and the seal says that and more. A status that says something of its own (running,
// ready, an error) keeps its glyph and gets the seal beside it. One rule for the board's card and the rail's row.
const SEAL_STANDS_IN: ReadonlySet<string> = new Set([`landed`, `idle`]);
export const sealStandsIn = (proof: ProofMark | undefined, status: string | undefined): boolean =>
    proof !== undefined && status !== undefined && SEAL_STANDS_IN.has(status);
