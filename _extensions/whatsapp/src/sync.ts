import { bareJid, contentOf, isGroupJid, isLidJid, isPhoneJid, looksLikePhone, phoneJidOf, PROTOCOL_EDIT, PROTOCOL_REVOKE, secondsOf, toSeconds, unwrap } from "./content.js";
import type { ContactInput, MessageRow, Resolution, StoredMessage, WaStore } from "./store.js";
import type { WaRawMessage } from "./types.js";

// Baileys' account events, written into the store. Structural (no baileys import) so a test can replay them: client.ts
// registers each handler on the socket's event emitter.

export interface ChatLike {
    readonly id?: string | null | undefined;
    readonly name?: string | null | undefined;
    readonly conversationTimestamp?: unknown;
}

export interface GroupLike {
    readonly id: string;
    readonly subject?: string | null;
    readonly participants?: readonly ContactInput[] | null;
}

export interface HistoryLike {
    readonly chats: readonly ChatLike[];
    readonly contacts: readonly ContactInput[];
    readonly messages: readonly WaRawMessage[];
    readonly lidPnMappings?: readonly { readonly lid: string; readonly pn: string }[] | undefined;
}

export interface StoreSync {
    readonly contacts: (contacts: readonly ContactInput[]) => void;
    readonly chats: (chats: readonly ChatLike[]) => void;
    readonly groups: (groups: readonly Partial<GroupLike>[]) => void;
    readonly lidMapping: (mapping: { readonly lid: string; readonly pn: string }) => void;
    // Returns the chats that gained messages, so an on-demand history request can tell its answer arrived.
    readonly history: (set: HistoryLike) => ReadonlySet<string>;
    readonly messages: (messages: readonly WaRawMessage[]) => void;
}

// Serializes a raw message for the store (BufferJSON in client.ts); `own` is our send, kept whole for retry answers.
export type Serialize = (raw: WaRawMessage, own: boolean) => string;

// A chat as the store takes it; one WhatsApp sent without an id has nowhere to go.
const chatInputs = (chats: readonly ChatLike[]): { id: string; name: string | null; lastAt: number | null }[] =>
    chats.flatMap((chat) => {
        if (chat.id === undefined || chat.id === null || chat.id === "") {
            return [];
        }
        const lastAt = toSeconds(chat.conversationTimestamp);
        return [{ id: chat.id, name: chat.name ?? null, lastAt: lastAt === 0 ? null : lastAt }];
    });

// The phone JID and @lid this message's author is known by; WhatsApp sends the other form alongside since v7.
const addressPair = (address: string | null | undefined, alt: string | null | undefined): { lid: string; phone: string } | undefined => {
    if (address === undefined || address === null || alt === undefined || alt === null) {
        return undefined;
    }
    if (isLidJid(address) && isPhoneJid(alt)) {
        return { lid: bareJid(address), phone: bareJid(alt) };
    }
    if (isPhoneJid(address) && isLidJid(alt)) {
        return { lid: bareJid(alt), phone: bareJid(address) };
    }
    return undefined;
};

export const createStoreSync = (store: WaStore, serialize: Serialize): StoreSync => {
    // The row a message becomes, or undefined for bookkeeping (an edit or delete is applied to its target instead).
    const toStored = (raw: WaRawMessage): StoredMessage | undefined => {
        const chat = raw.key.remoteJid;
        const id = raw.key.id;
        if (chat === undefined || chat === null || id === undefined || id === null || chat === "status@broadcast") {
            return undefined;
        }
        for (const pair of [addressPair(raw.key.remoteJid, raw.key.remoteJidAlt), addressPair(raw.key.participant, raw.key.participantAlt)]) {
            if (pair !== undefined) {
                store.mapLid(pair.lid, pair.phone);
            }
        }
        const content = unwrap(raw.message);
        const protocol = content?.protocolMessage;
        const target = protocol?.key?.id;
        if (protocol !== undefined && protocol !== null) {
            if (target !== undefined && target !== null && protocol.type === PROTOCOL_EDIT) {
                const text = contentOf(unwrap(protocol.editedMessage));
                if (text !== "") {
                    store.editMessage(chat, target, `${text} [edited]`);
                }
            }
            if (target !== undefined && target !== null && protocol.type === PROTOCOL_REVOKE) {
                store.deleteMessage(chat, target);
            }
            return undefined;
        }
        const reaction = content?.reactionMessage;
        const text =
            reaction === undefined || reaction === null
                ? contentOf(content)
                : reaction.text === undefined || reaction.text === null || reaction.text === ""
                  ? `[removed a reaction from ${reaction.key?.id ?? "a message"}]`
                  : `[reacted ${reaction.text} to ${reaction.key?.id ?? "a message"}]`;
        if (text === "") {
            return undefined;
        }
        const fromMe = raw.key.fromMe === true;
        const author = fromMe ? undefined : isGroupJid(chat) ? (raw.key.participant ?? undefined) : chat;
        return {
            chat,
            id,
            fromMe,
            ...(author === undefined || author === "" ? {} : { author: bareJid(author) }),
            ...(raw.pushName === undefined || raw.pushName === null || raw.pushName === "" ? {} : { authorName: raw.pushName }),
            text,
            ts: secondsOf(raw),
            raw: serialize(raw, fromMe),
        };
    };

    const messages = (raws: readonly WaRawMessage[]): void => {
        store.addMessages(raws.flatMap((raw) => toStored(raw) ?? []));
    };

    return {
        contacts: (contacts) => store.upsertContacts(contacts),
        chats: (chats) => store.upsertChats(chatInputs(chats)),
        groups: (groups) => {
            store.upsertChats(groups.flatMap((group) => (group.id === undefined ? [] : [{ id: group.id, name: group.subject ?? null }])));
            // Participants carry both addresses and sometimes a name: the cheapest LID map there is.
            store.upsertContacts(groups.flatMap((group) => group.participants ?? []));
        },
        lidMapping: ({ lid, pn }) => store.mapLid(bareJid(lid), bareJid(pn)),
        history: (set) => {
            for (const mapping of set.lidPnMappings ?? []) {
                store.mapLid(bareJid(mapping.lid), bareJid(mapping.pn));
            }
            store.upsertContacts(set.contacts);
            store.upsertChats(chatInputs(set.chats));
            messages(set.messages);
            return new Set(set.messages.flatMap((raw) => (raw.key.remoteJid === undefined || raw.key.remoteJid === null ? [] : [bareJid(raw.key.remoteJid)])));
        },
        messages,
    };
};

// Who wrote a message: their phone JID and @lid when known, and the best name for them.
export interface Sender {
    phone?: string;
    lid?: string;
    name?: string;
}

// Who wrote a message, by both of their addresses and the best name for them: the message's own address pair first,
// then the store's LID map, then `lookupPhone` (Baileys' key files, in client.ts); saved name before pushName.
export const senderOf = async (store: WaStore, raw: WaRawMessage, lookupPhone: (lid: string) => Promise<string | undefined>): Promise<Sender> => {
    const chat = raw.key.remoteJid ?? "";
    const group = isGroupJid(chat);
    const address = group ? raw.key.participant : chat;
    const alt = group ? raw.key.participantAlt : raw.key.remoteJidAlt;
    const pair = [address, alt].flatMap((jid) => (jid === undefined || jid === null || jid === "" ? [] : [bareJid(jid)]));
    const sender: Sender = {};
    const lid = pair.find(isLidJid);
    if (lid !== undefined) {
        sender.lid = lid;
    }
    const phone = pair.find(isPhoneJid) ?? (lid === undefined ? undefined : (store.phoneForLid(lid) ?? (await lookupPhone(lid))));
    if (phone !== undefined) {
        sender.phone = phone;
    }
    const name = store.nameOf(phone ?? lid ?? chat) ?? (raw.pushName === "" ? undefined : raw.pushName) ?? undefined;
    if (name !== undefined) {
        sender.name = name;
    }
    return sender;
};

// The chat's last `limit` stored messages, oldest first, leaving out the one with id `exclude` (the message being
// dispatched, already stored by the time the listener sees it).
export const recentOf = (store: WaStore, chat: string, limit: number, exclude?: string): MessageRow[] =>
    store
        .recent(chat, limit + (exclude === undefined ? 0 : 1))
        .filter((row) => row.id !== exclude)
        .slice(-limit);

// A chat settled on: its JID, and the name it was found by when it was found by name.
export interface ChatJid {
    readonly kind: "jid";
    readonly jid: string;
    label?: string;
}

// Free text the CLI was given for a chat, settled: a JID to send to, or the people it could have meant.
export type ChatTarget = ChatJid | Exclude<Resolution, { kind: "found" }>;

// A JID, a phone number or a name, as the chat to send to. A phone number goes through the chat WhatsApp already keeps
// for that person, else through their @lid: a send to the phone JID of a contact WhatsApp tracks by @lid can land in a
// thread only the sender sees (openclaw #67378). `localLid` reads Baileys' own map without asking the network.
export const resolveChatIn = async (store: WaStore, target: string, localLid: (phone: string) => Promise<string | undefined>): Promise<ChatTarget> => {
    const text = target.trim();
    const viaPhone = async (phone: string): Promise<ChatTarget> => ({ kind: "jid", jid: store.chatForPhone(phone, await localLid(phone)) });
    if (text.includes("@")) {
        const jid = bareJid(text.toLowerCase()).replace(/@c\.us$/, "@s.whatsapp.net");
        return isPhoneJid(jid) ? viaPhone(jid) : { kind: "jid", jid };
    }
    if (looksLikePhone(text)) {
        return viaPhone(phoneJidOf(text));
    }
    const found = store.resolve(text);
    if (found.kind !== "found") {
        return found;
    }
    const settled: ChatJid = { kind: "jid", jid: found.entry.jid };
    const label = found.entry.name ?? found.entry.chatName ?? found.entry.notify;
    if (label !== undefined) {
        settled.label = label;
    }
    return settled;
};
