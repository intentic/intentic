import type { ConversationActors } from "../actor/conversation-actors.js";
import type { PersistedAgent } from "./agents-store.js";

// What a fleet just loaded from its store does before anything reads it (agents-registry.ts, `init`). Queues survive a
// sleep on the entries, but the schedulers enumerate actors: those are restored first, so no wake reader reports the
// sandbox quiet, or sets its alarm, with a booked message unseen. Then the roster goes out before the standings are
// probed, since a fresh boot's verdict cache is empty and the probe spawns git per live agent.
export const activateLoadedFleet = (
    entries: readonly PersistedAgent[],
    conversations: Pick<ConversationActors, "queued">,
    broadcast: () => void,
    reprobe: () => Promise<boolean>,
): void => {
    for (const entry of entries) {
        conversations.queued(entry.id);
    }
    broadcast();
    void reprobe()
        .then((moved) => {
            if (moved) {
                broadcast();
            }
        })
        // allow(silent-catch): reprobe never throws; a broadcast that does leaves the next change to carry the standings.
        .catch(() => undefined);
};
