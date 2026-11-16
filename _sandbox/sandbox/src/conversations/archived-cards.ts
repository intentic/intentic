import { setImmediate as nextTurn } from "node:timers/promises";
import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import type { Caller } from "../auth/auth.js";
import { framedSummary } from "../auth/fleet-scope.js";
import type { Services } from "../composition.js";

// Cards built between yields to the event loop. Building the archive's five thousand cards in one go held the loop for
// one to two and a half seconds per read (`/agents/archived` ended inside 14 of the 123 CPU-bound stalls of 2026-11-04 to
// 11-16); a slice of these takes a few milliseconds, and the loop runs its timers and I/O between slices.
const ARCHIVE_SLICE = 200;

// The archive, newest-archived first (registry.listArchived's order), as this caller may see it.
export const archivedCards = async (
    agents: Pick<Services["agents"], "ids" | "entry" | "get">,
    caller: Caller | undefined,
): Promise<AgentSummary[]> => {
    const archived = agents
        .ids()
        .flatMap((id) => {
            const archivedAt = agents.entry(id)?.archivedAt;
            return archivedAt === undefined ? [] : [{ id, archivedAt }];
        })
        .toSorted((a, b) => b.archivedAt - a.archivedAt);
    const cards: AgentSummary[] = [];
    for (let start = 0; start < archived.length; start += ARCHIVE_SLICE) {
        if (start > 0) {
            await nextTurn();
        }
        for (const { id } of archived.slice(start, start + ARCHIVE_SLICE)) {
            const summary = agents.get(id);
            const card = summary === undefined ? undefined : framedSummary(caller, summary);
            if (card !== undefined) {
                cards.push(card);
            }
        }
    }
    return cards;
};
