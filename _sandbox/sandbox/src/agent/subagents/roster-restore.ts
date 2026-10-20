import type { SubagentStatus, SubagentVerification } from "@intentic/sandbox-contract/schemas/terminal";
import { LIVE, ROSTER } from "../../conversations/actor/subagent-roster.js";
import { opt } from "../../opt.js";
import { open, type SpawnedChildBirth, type SubagentTurn } from "./subagents.js";

// A spawned child's roster row put back at boot from its file (child-restore.ts), beside the rows subagents.ts opens as
// children are born.

/** A spawned child's row as its file brings it back at boot (child-restore.ts, spawnedChildrenInFlight). */
export interface RestoredChildRow extends SpawnedChildBirth {
    readonly status: SubagentStatus;
    readonly startedAt: number;
    readonly endedAt?: number;
    readonly summary?: string;
    readonly error?: string;
    readonly verification?: SubagentVerification;
}

/**
 * Puts a spawned child's row back after a restart, announcing nothing: it is the same subagent its parent already counted.
 * An ending from before the restart counts as handed over, so a wait on "any" does not hand it out a second time; a wait
 * that names the child still answers with it.
 */
export const restoreSpawnedChild = (turn: SubagentTurn, row: RestoredChildRow): void => {
    if (turn.conversations.holdings(ROSTER).has(row.id)) {
        return;
    }
    const ended = !LIVE.has(row.status);
    open(turn, row.id, "spawned", {
        background: true,
        status: row.status,
        startedAt: row.startedAt,
        activityAt: row.endedAt ?? row.startedAt,
        ...opt("endedAt", ended ? (row.endedAt ?? row.startedAt) : undefined),
        ...opt("description", row.description),
        ...opt("agentType", row.agentType),
        ...opt("model", row.model),
        ...opt("provider", row.provider),
        ...opt("spawnDepth", row.spawnDepth),
        ...opt("summary", row.summary),
        ...opt("summarySource", row.summary === undefined || !ended ? undefined : ("report" as const)),
        ...opt("error", row.error),
        ...opt("verification", row.verification),
        ...opt("reported", ended ? row.status : undefined),
    });
};
