import type { TurnJournal } from "../../agent/run/turn/turn-journal.js";
import { type AgentArchiveDeps, archivable, archiveAgents } from "./archive.js";
import { massAbsence } from "./mass-absence.js";

export interface VanishedWorktreeDeps extends AgentArchiveDeps {
    readonly turnJournal: Pick<TurnJournal, "list">;
}

// Archives the conversations whose checkout has ended for good, at boot; answers the ids it archived. Destructive on
// a reading of the disk, so it acts only on a reading that is certain:
// - a probe that failed rather than answered (EACCES, EIO, ENOTDIR) is unknown and acts on nothing
// - a checkout off disk whose `agent/<id>` survives is left alone: diff and land read the branch while it is detached,
//   and the next ensure re-attaches it
// - a pass reading most of the board off disk at once is an outage, and acts on none of it (mass-absence.ts)
// - a conversation running, or one this boot is resuming (its journal entry), is left alone: an archived one is
//   refused the resume
// What is left goes through the archive's own door (archiveAgents) and only where the board would let it go
// (`archivable`), so its watches and processes go with it.
export const archiveVanishedWorktrees = async (deps: VanishedWorktreeDeps, now: number): Promise<string[]> => {
    const { agents, agentWorktrees, conversations, logger } = deps;
    const probed = new Map<string, Awaited<ReturnType<typeof agentWorktrees.presence>>>();
    for (const id of agents.ids()) {
        const entry = agents.entry(id);
        // Workspace conversations own no checkout; an archived entry is held by its commits, not a worktree.
        if (entry?.placement.kind !== "worktree" || entry.archivedAt !== undefined) {
            continue;
        }
        probed.set(id, await agentWorktrees.presence(id));
    }
    const offDisk = [...probed.values()].filter((presence) => presence === "restorable" || presence === "gone").length;
    if (massAbsence(offDisk, probed.size)) {
        logger.error({ offDisk, probed: probed.size }, "agents: most checkouts read missing at once, taken for an outage; nothing is archived");
        return [];
    }
    const gone = [...probed].filter(([, presence]) => presence === "gone").map(([id]) => id);
    if (gone.length === 0) {
        return [];
    }
    // Unreadable means the boot cannot tell which conversations it is about to resume, so none is archived.
    let journal: Awaited<ReturnType<typeof deps.turnJournal.list>>;
    try {
        journal = await deps.turnJournal.list();
    } catch (error) {
        logger.warn({ err: error }, "agents: turn journal unreadable, no conversation with a vanished checkout is archived");
        return [];
    }
    const resuming = new Set(journal.map((entry) => (entry.kind === "turn" ? entry.turn.conversationId : entry.conversationId)));
    const finished = new Set(agents.list().filter(archivable).map(({ id }) => id));
    const ended = gone.filter((id) => finished.has(id) && !resuming.has(id) && !conversations.running(id));
    if (ended.length === 0) {
        return [];
    }
    // Archived, never deleted: deletion stays where the user can see it.
    const { archived } = await archiveAgents(deps, ended, now);
    logger.info({ count: archived.length }, "agents: archived entries whose worktree and branch are both gone");
    return archived;
};
