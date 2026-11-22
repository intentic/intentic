import type { AutoApproveMark } from "@intentic/sandbox-contract/schemas/auto-approve";
import { autoApproveOf, supervisorIn } from "../../roles/standing-answer.js";
import type { PersistedAgent } from "./agents-store.js";

// The auto-approve marks as the cards wear them (AgentSummary.autoApprove): kept in the conversation grants, which answer
// only asynchronously, while a card is projected synchronously. So they are read once as the registry loads, again on
// every write that changes a grant, and again by the route that puts one on, before it answers with the cards it moved.
// The card registry never reads this copy: it asks the grants themselves as each card is raised (parked-cards.ts).

/** The grants as the registry follows them: who is marked now (undefined when they could not be read), and every write. */
export interface AutoApproveSource {
    readonly marked: () => Promise<ReadonlySet<string> | undefined>;
    readonly onChange: (listener: () => void) => () => void;
}

export interface AutoApproveMarks {
    // Where the mark reaches this conversation from, as last read.
    readonly of: (entry: Pick<PersistedAgent, "id">) => AutoApproveMark;
    // Reads them now, and again on every write.
    readonly follow: () => Promise<void>;
    // Reads them again now, for a write whose answer must carry the cards as they read after it.
    readonly reload: () => Promise<void>;
}

const NONE: ReadonlySet<string> = new Set();

const sameSet = (left: ReadonlySet<string>, right: ReadonlySet<string>): boolean => left.size === right.size && [...left].every((id) => right.has(id));

// Without a source (a fixture), nothing is marked, as an empty grants file says. `changed` hears every read that moved a
// mark, which is the cards' cue to publish again.
export const autoApproveMarks = (
    source: AutoApproveSource | undefined,
    entryOf: (id: string) => Pick<PersistedAgent, "identity"> | undefined,
    changed: () => void,
): AutoApproveMarks => {
    let marked = NONE;
    const parentOf = supervisorIn(entryOf);
    const reload = async (): Promise<void> => {
        const read = await source?.marked();
        if (read === undefined || sameSet(read, marked)) {
            return;
        }
        marked = read;
        changed();
    };
    return {
        of: (entry) => (marked.size === 0 ? undefined : autoApproveOf((id) => marked.has(id), parentOf, entry.id)),
        follow: async () => {
            await reload();
            source?.onChange(() => void reload());
        },
        reload,
    };
};
