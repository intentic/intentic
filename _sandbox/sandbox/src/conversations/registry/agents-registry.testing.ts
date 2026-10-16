import { IN_MEMORY } from "@intentic/base/sqlite";
import { turnJournalRows } from "../../store/journals/turn-journal.js";
import { type ConversationsDb, openConversationsDb } from "../../store/conversations-db.js";
import type { ConversationUnits } from "../../store/conversation-units.js";
import type { ConversationEvent } from "../actor/conversation-decide.js";
import { noPresences } from "../land/landed-presence.testing.js";
import { createFleet, type Fleet, type FleetStore } from "./agents-registry.js";
import { sqliteAgentsStore } from "./agents-store.js";

// What the fleet writes through, over one conversations database; a directory a leaving conversation takes with it is
// the caller's to give, and nothing on disk when it gives none.
export const fleetStoreOver = (db: ConversationsDb, units: Pick<ConversationUnits, "remove"> = { remove: async () => {} }): FleetStore => ({
    agents: sqliteAgentsStore(db),
    journal: turnJournalRows(db),
    transaction: db.transaction,
    units,
});

// A fleet over nothing: entries kept in an in-memory database (the real store, the real SQL), and land probes that
// never find a standing or a presence to report. Pass the store over the database a suite's other stores share.
export const memoryFleet = (store: FleetStore = fleetStoreOver(openConversationsDb(IN_MEMORY))): Fleet =>
    createFleet(store, { of: () => "idle", causesOf: () => [], refresh: async () => false, forget: () => {} }, noPresences());

// A memory fleet that also hands every conversation event to `note` as it is sent, for suites pinning what a flow tells
// a conversation, and in which order.
export const notedFleet = (note: (conversationId: string, event: ConversationEvent) => void, store?: FleetStore): Fleet => {
    const { agents, conversations } = memoryFleet(store);
    return {
        agents,
        conversations: {
            ...conversations,
            send: (conversationId, event, now) => {
                note(conversationId, event);
                return conversations.send(conversationId, event, now);
            },
        },
    };
};
