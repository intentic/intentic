import { IN_MEMORY } from "@intentic/base/sqlite";
import type { WhatsAppConnection } from "./client.js";
import type { WhatsAppListener } from "./listener.js";
import { openWaStore, type WaStore } from "./store.js";
import { createStoreSync, recentOf, resolveChatIn, senderOf, type StoreSync } from "./sync.js";
import type { WaRawMessage } from "./types.js";

// The one fake WhatsApp connection the package's tests stand up: a real store in memory behind the reads (names,
// history, LID map), and every outbound call recorded instead of sent. Excluded from the build.

export const SELF = "4915100000001";
export const SELF_LID = "123456789";

export interface FakeWhatsApp {
    readonly connection: WhatsAppConnection;
    readonly store: WaStore;
    readonly sync: StoreSync;
    readonly calls: { method: string; args: unknown[] }[];
    // What the client does with a live message: store it, then hand it to the listener.
    readonly deliver: (listener: WhatsAppListener, raw: WaRawMessage) => void;
}

export const fakeWhatsApp = (): FakeWhatsApp => {
    const store = openWaStore(IN_MEMORY);
    const sync = createStoreSync(store, (raw) => JSON.stringify(raw));
    const calls: { method: string; args: unknown[] }[] = [];
    const record =
        (method: string) =>
        async (...args: unknown[]): Promise<void> =>
            void calls.push({ method, args });
    const connection: WhatsAppConnection = {
        capabilityId: "whatsapp-1",
        selfJid: () => `${SELF}@s.whatsapp.net`,
        selfLid: () => `${SELF_LID}@lid`,
        phase: () => "ready",
        pairing: () => undefined,
        sendText: record("sendText"),
        sendFile: record("sendFile"),
        sendVoice: record("sendVoice"),
        react: record("react"),
        presence: record("presence"),
        sender: (raw) => senderOf(store, raw, async () => undefined),
        nameOf: (jid) => store.nameOf(jid),
        recent: (chat, limit, exclude) => recentOf(store, chat, limit, exclude),
        resolveChat: (target) => resolveChatIn(store, target, async () => undefined),
        searchContacts: (query) => store.search(query),
        listChats: async () => store.directory().toSorted((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0)),
        history: async (chat, limit) => ({ messages: store.recent(chat, limit), fetch: "stored" }),
        download: async () => undefined,
    };
    return {
        connection,
        store,
        sync,
        calls,
        deliver: (listener, raw) => {
            sync.messages([raw]);
            listener.onMessage(connection, raw);
        },
    };
};
