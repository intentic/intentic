import type { MainlineLand, MainlineRoutingKind, MainlineRun, MainlineStatus, TurnProof } from "@intentic/sandbox-contract";
import { daemonOutdated } from "./mainlineView";

// WHAT A CARD SAYS ABOUT ITS WORK NOW THAT NOTHING IS CHECKED INSIDE A TURN: what the main tree's own check made of the
// conversation's latest land (workspace.mainline), and what its last turn showed of its own work (AgentSummary.proof).
// Pure functions over plain data, no store, no Vue, like agentStatus.ts: the words belong to the marks that draw these
// (CardSeal.vue), so a rail row and a board card read one projection and cannot disagree about it.

export type LandCheckKind = `checking` | `waiting` | `passed` | `broke` | `checked-red`;

export interface LandCheck {
    readonly kind: LandCheckKind;
    // Which project's check, by folder relative to the workspace; empty is the workspace root.
    readonly project: string;
    // checking: when the check started; waiting: when the land asked for one; otherwise when the run that answered ended.
    readonly since: number;
    // broke: how many failures that run named; zero when it wrote no list.
    readonly failures?: number;
    // broke: what became of them, once the sandbox decided.
    readonly routing?: MainlineRoutingKind;
    // broke: the OTHER conversation that has them: a fresh fix-up, or one still working that the repair waits for.
    readonly fixUp?: string;
}

const holds = (lands: readonly MainlineLand[], conversationId: string): boolean => lands.some((land) => land.conversationId === conversationId);

// Laid at this conversation: among the suspects the sandbox filed on the run as it settled (a red that only found main
// red names nobody), the same answer the panel's cause reads.
const blamed = (run: MainlineRun, conversationId: string): boolean => (run.suspects ?? []).includes(conversationId);

// The answer to the newest land: every run that measured it, since a land touching two projects is checked in each, and
// the worse of them is what it did.
const settled = (conversationId: string, recent: readonly MainlineRun[]): LandCheck | undefined => {
    const newest = recent.find((run) => holds(run.lands, conversationId));
    const at = newest?.lands.find((land) => land.conversationId === conversationId)?.at;
    if (newest === undefined || at === undefined) {
        return undefined;
    }
    const answering = recent.filter((run) => run.lands.some((land) => land.conversationId === conversationId && land.at === at));
    const broke = answering.find((run) => run.status === `red` && blamed(run, conversationId));
    if (broke !== undefined) {
        const other = broke.routing?.conversationId;
        return {
            kind: `broke`,
            project: broke.project,
            since: broke.at,
            failures: broke.failureCount,
            ...(broke.routing === undefined ? {} : { routing: broke.routing.kind }),
            ...(other === undefined || other === conversationId ? {} : { fixUp: other }),
        };
    }
    const red = answering.find((run) => run.status === `red`);
    const answer = red ?? newest;
    return { kind: red === undefined ? `passed` : `checked-red`, project: answer.project, since: answer.at };
};

// A check running on the land outranks one it is queued for, which outranks one already settled: the newest land is the
// one a reader is asking about, and a queued or running one is newer than anything in the record. A sandbox too old to
// lay its reds (daemonOutdated) files suspects only once it has sent somebody, so what it settled says nothing on a card:
// a land it blamed would read as merely checked red.
export const landCheck = (conversationId: string, status: MainlineStatus | undefined): LandCheck | undefined => {
    if (status === undefined) {
        return undefined;
    }
    for (const project of status.projects) {
        if (project.running !== undefined && holds(project.running.lands, conversationId)) {
            return { kind: `checking`, project: project.project, since: project.running.startedAt };
        }
    }
    for (const project of status.projects) {
        const queued = project.queued.find((land) => land.conversationId === conversationId);
        if (queued !== undefined) {
            return { kind: `waiting`, project: project.project, since: queued.at };
        }
    }
    return daemonOutdated(status) ? undefined : settled(conversationId, status.recent);
};

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

export interface CardChecks {
    readonly land?: LandCheck;
    readonly proof?: ProofMark;
}

// ONE MARK FOR BOTH READINGS: the card's seal (CardSeal.vue), where the worst of them wins. A reader learns four shapes
// instead of reading up to three phrases on every finished card, and only a red, the one answer that asks for anything,
// also keeps its words on the card.
// `checked-red` is not this card's red, since the failures were laid at other work, but it is no pass either: main could
// not vouch for the land, so the seal stays open.
// Main passing does NOT close a seal the turn left open. Main's check is the project's suite, and it says nothing about
// an interface nobody looked at, or about code the suite never reaches.
// A land queued for a check it has not had is its own kind: nothing is happening to it yet, so nothing on it moves.
export type SealKind = `broke` | `checking` | `queued` | `open` | `closed`;

export const sealOf = ({ land, proof }: CardChecks): SealKind => {
    if (land?.kind === `broke` || proof?.verification === `failing`) {
        return `broke`;
    }
    if (land?.kind === `checking`) {
        return `checking`;
    }
    if (land?.kind === `waiting`) {
        return `queued`;
    }
    if (land?.kind === `checked-red` || proof?.verification === `unproven` || proof?.unviewed !== undefined) {
        return `open`;
    }
    return `closed`;
};

// Both readings for one card. Main's check only for this sandbox's own agents, the only lands its record holds. The
// proof is the LAST turn's, so a turn under way hides it rather than wear an answer about work it is already redoing.
export const cardChecks = (
    agent: { readonly id: string; readonly sandboxId?: string; readonly proof?: TurnProof },
    status: MainlineStatus | undefined,
    working: boolean,
): CardChecks | undefined => {
    const land = agent.sandboxId === undefined ? landCheck(agent.id, status) : undefined;
    const proof = working ? undefined : proofMark(agent.proof);
    if (land === undefined && proof === undefined) {
        return undefined;
    }
    return { ...(land === undefined ? {} : { land }), ...(proof === undefined ? {} : { proof }) };
};
