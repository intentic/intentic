// ONE AUTOMATION, ONE CARD. Every fire of an automation that starts an agent opens a conversation of its own, so an
// automation on a ten-minute clock fills the board with a card per run, each named afresh by the naming pass, until a
// person's own work is lost among a hundred cards telling one story. So the runs of one automation ride under one card,
// as a spawned child rides under its parent (agent-lanes.ts attentionCalls, and the editor's childFold.ts, which draws
// it): the card of its latest run, with the earlier runs as rows in its tray. Which card that is, and which runs ride
// it, is decided here once, so the board and the daemon's count of what needs the person (`agents.attention`) agree.

// Enough of a conversation to say which automation's run it is and when it last moved; a FleetAgent, a roster
// AgentSummary and a test literal all fit.
export interface StackMember {
    readonly id: string;
    readonly origin?: { readonly automationId: string } | undefined;
    readonly startedAt?: number | undefined;
    readonly updatedAt: number;
}

// How the daemon names a conversation an automation minted (automations/fire/fire-sessions.ts mintConversationId): `a-`,
// the automation's id cut to 40 characters, `-`, then a base36 stamp with no `-` in it. Read only for a run with no
// origin, which is every run a schedule fired before the daemon recorded one, so the board stacks those too.
const MINTED = /^a-(.+)-[0-9a-z]+$/;

// The automation whose run this conversation is, or undefined for one a person or another agent started.
export const automationOf = (agent: Pick<StackMember, "id" | "origin">): string | undefined =>
    agent.origin?.automationId ?? MINTED.exec(agent.id)?.[1];

// When a run last moved, as a stack orders its runs: a running turn's start, which holds still for the turn's life so
// two runs at work at once never trade places on every tick, else its last move.
export const movedAt = (run: Pick<StackMember, "startedAt" | "updatedAt">): number => run.startedAt ?? run.updatedAt;

// Whether `a` is the later of two runs; the id breaks a tie, so every surface picks the same one.
const later = (a: StackMember, b: StackMember): boolean => movedAt(a) > movedAt(b) || (movedAt(a) === movedAt(b) && a.id > b.id);

// The latest run of each automation among `agents`, by the key `stackOf` gives it (the automation, and on a board that
// holds several sandboxes' cards, the sandbox too); undefined skips a conversation that is no automation's run.
export const stackHeads = <T extends StackMember>(agents: Iterable<T>, stackOf: (agent: T) => string | undefined): ReadonlyMap<string, T> => {
    const heads = new Map<string, T>();
    for (const agent of agents) {
        const key = stackOf(agent);
        if (key === undefined) {
            continue;
        }
        const head = heads.get(key);
        if (head === undefined || later(agent, head)) {
            heads.set(key, agent);
        }
    }
    return heads;
};
