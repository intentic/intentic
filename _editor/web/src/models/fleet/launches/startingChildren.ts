import type { SubagentSession } from "@intentic/sandbox-contract/schemas/terminal";

// SPAWNED CHILDREN ON THE BOARD BEFORE THEY EXIST, as agentLaunches.ts is for an agent a press elsewhere starts. The
// daemon files a child in its roster the moment its parent asks for it, but the fleet holds it only once its first turn
// begins, and a start can wait minutes before that: on the owner's answer, behind its lane's first child until a
// provider nothing had proven answers (fan-out-governor.ts), for a seat or for memory. Until then its roster row stands
// in for it in its parent's tray (subagentRoster.rowsOf, ChildStartingRow).

const NO_IDS: ReadonlySet<string> = new Set<string>();

// The ids of the spawned children still on their way to the fleet, given the roster's live spawned rows: those with no
// conversation the fleet holds. The same set while its members stand still, so a fleet tick that moved none of them
// wakes no tray; with no spawned child live at all, the fleet is not even read, which is why it is handed in as a thunk.
export const startingIds = (
    live: readonly Pick<SubagentSession, "id">[],
    fleet: () => readonly { readonly id: string }[],
    previous: ReadonlySet<string> | undefined,
): ReadonlySet<string> => {
    if (live.length === 0) {
        return previous?.size === 0 ? previous : NO_IDS;
    }
    const held = new Set(fleet().map((agent) => agent.id));
    const starting = new Set(live.filter((session) => !held.has(session.id)).map((session) => session.id));
    return previous !== undefined && previous.size === starting.size && [...starting].every((id) => previous.has(id)) ? previous : starting;
};
