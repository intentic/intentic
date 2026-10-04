import type { DatabaseSync, StatementSync } from "node:sqlite";
import { immediateTransaction, openSqlite } from "@intentic/base/sqlite";
import { bareJid, isGroupJid, isLidJid, isPhoneJid, jidUser } from "./content.js";

// What this linked device has learned about its account, kept across restarts in one SQLite file inside the session
// dir, so unlinking (which wipes that dir) takes it along. WhatsApp hands a linked device the address book, chat list
// and recent messages ONCE, right after pairing, then only deltas; a device that drops them has no way to ask again
// short of a resync. Holds:
// - contacts: who the owner saved (name) and what people call themselves (notify), keyed by phone JID when known;
// - lid_map: WhatsApp's privacy ids (@lid) to phone JIDs, since a person may write from either;
// - chats: every chat seen, with its name (a group's subject, a DM's contact name);
// - messages: a bounded per-chat log, the history the agent can read back, with each raw message for media
//   download, quoting and answering WhatsApp's retry requests.
// Baileys-free: raw messages arrive already serialized, so this file is testable without a socket.

const SCHEMA_VERSION = "1";
// Messages kept per chat; the oldest go first. The phone keeps the full history and can be asked for more.
export const MESSAGES_PER_CHAT = 1_000;

export interface ContactInput {
    readonly id: string;
    readonly lid?: string | null | undefined;
    readonly phoneNumber?: string | null | undefined;
    readonly name?: string | null | undefined;
    readonly notify?: string | null | undefined;
    readonly verifiedName?: string | null | undefined;
    readonly username?: string | null | undefined;
}

export interface ChatInput {
    readonly id: string;
    readonly name?: string | null | undefined;
    // Epoch seconds of the chat's last activity.
    readonly lastAt?: number | null | undefined;
}

export interface StoredMessage {
    readonly chat: string;
    readonly id: string;
    readonly fromMe: boolean;
    // Raw JID of who wrote it (phone or @lid); absent for our own sends.
    readonly author?: string | undefined;
    readonly authorName?: string | undefined;
    readonly text: string;
    // Epoch seconds.
    readonly ts: number;
    // The whole message, serialized by the caller (BufferJSON), for download, quoting and retry answers.
    readonly raw?: string | undefined;
}

export interface MessageRow extends StoredMessage {
    readonly raw?: string;
}

// One person or group as the CLI shows it: where to send, and every name WhatsApp has for them.
export interface DirectoryEntry {
    // The chat JID to send to: an existing chat's own JID when there is one, else the @lid, else the phone JID.
    readonly jid: string;
    readonly kind: "dm" | "group";
    readonly phone?: string;
    readonly lid?: string;
    // Saved in the owner's address book.
    readonly name?: string;
    // The chat's title as the phone lists it (a group's subject, a DM's display name).
    readonly chatName?: string;
    // What the person calls themselves on WhatsApp (pushName).
    readonly notify?: string;
    readonly verified?: string;
    readonly username?: string;
    readonly lastAt?: number;
}

export type Resolution =
    | { readonly kind: "found"; readonly entry: DirectoryEntry }
    | { readonly kind: "ambiguous"; readonly candidates: readonly DirectoryEntry[] }
    | { readonly kind: "none" };

export interface WaStore {
    readonly upsertContacts: (contacts: readonly ContactInput[]) => void;
    readonly upsertChats: (chats: readonly ChatInput[]) => void;
    readonly mapLid: (lid: string, phone: string) => void;
    readonly phoneForLid: (lid: string) => string | undefined;
    readonly lidForPhone: (phone: string) => string | undefined;
    readonly addMessages: (messages: readonly StoredMessage[]) => void;
    readonly editMessage: (chat: string, id: string, text: string) => void;
    readonly deleteMessage: (chat: string, id: string) => void;
    // Oldest first, the last `limit` messages of the chat (before `beforeTs` seconds when given).
    readonly recent: (chat: string, limit: number, beforeTs?: number) => MessageRow[];
    readonly oldest: (chat: string) => MessageRow | undefined;
    readonly countIn: (chat: string) => number;
    // A message by id, narrowed to one chat when the id alone could collide.
    readonly message: (id: string, chat?: string) => MessageRow | undefined;
    // Everyone and every group this store knows, people merged across their phone and @lid identities.
    readonly directory: () => DirectoryEntry[];
    // Ranked name/number search over the directory.
    readonly search: (query: string) => DirectoryEntry[];
    // One chat for free text: a unique exact or prefix name match, else the candidates, else nothing.
    readonly resolve: (query: string) => Resolution;
    // The best name for a person or chat JID, saved name first.
    readonly nameOf: (jid: string) => string | undefined;
    // The chat to address a phone JID through, without asking the network: see DirectoryEntry.jid.
    readonly chatForPhone: (phone: string, knownLid?: string) => string;
    readonly contactCount: () => number;
    readonly meta: (key: string) => string | undefined;
    readonly setMeta: (key: string, value: string) => void;
    readonly close: () => void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS contacts (
    jid TEXT PRIMARY KEY,
    phone TEXT,
    lid TEXT,
    name TEXT,
    notify TEXT,
    verified TEXT,
    username TEXT
);
CREATE TABLE IF NOT EXISTS lid_map (lid TEXT PRIMARY KEY, phone TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS lid_map_phone ON lid_map(phone);
CREATE TABLE IF NOT EXISTS chats (jid TEXT PRIMARY KEY, name TEXT, kind TEXT NOT NULL, last_at INTEGER);
CREATE TABLE IF NOT EXISTS messages (
    chat TEXT NOT NULL,
    id TEXT NOT NULL,
    from_me INTEGER NOT NULL,
    author TEXT,
    author_name TEXT,
    text TEXT NOT NULL,
    ts INTEGER NOT NULL,
    raw TEXT,
    PRIMARY KEY (chat, id)
);
CREATE INDEX IF NOT EXISTS messages_chat_ts ON messages(chat, ts);
CREATE INDEX IF NOT EXISTS messages_id ON messages(id);
`;

// Absent, null and "" all mean "WhatsApp did not say"; none of them may erase a name already known.
const present = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === "" ? null : value.trim());

// Case- and accent-insensitive form for matching names; only Latin combining accents are dropped, since the marks of
// scripts like Khmer or Devanagari are letters, not decoration.
export const foldName = (text: string): string =>
    text
        .normalize("NFKD")
        .replaceAll(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replaceAll(/\s+/g, " ")
        .trim();

// Chats that are neither a person nor a group: status updates, broadcast lists, channels.
const ignoredChat = (jid: string): boolean => jid === "status@broadcast" || jid.endsWith("@broadcast") || jid.endsWith("@newsletter");

interface ContactRow {
    jid: string;
    phone: string | null;
    lid: string | null;
    name: string | null;
    notify: string | null;
    verified: string | null;
    username: string | null;
}

interface ChatRow {
    jid: string;
    name: string | null;
    kind: string;
    last_at: number | null;
}

interface RawMessageRow {
    chat: string;
    id: string;
    from_me: number;
    author: string | null;
    author_name: string | null;
    text: string;
    ts: number;
    raw: string | null;
}

const toMessage = (row: RawMessageRow): MessageRow => ({
    chat: row.chat,
    id: row.id,
    fromMe: row.from_me === 1,
    ...(row.author === null ? {} : { author: row.author }),
    ...(row.author_name === null ? {} : { authorName: row.author_name }),
    text: row.text,
    ts: row.ts,
    ...(row.raw === null ? {} : { raw: row.raw }),
});

export const openWaStore = (path: string): WaStore => {
    const db: DatabaseSync = openSqlite(path);
    db.exec(SCHEMA);
    const version = (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value?: string } | undefined)?.value;
    if (version === undefined) {
        db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(SCHEMA_VERSION);
    } else if (version !== SCHEMA_VERSION) {
        db.close();
        throw new Error(`whatsapp store schema ${version} != ${SCHEMA_VERSION}`);
    }

    let closed = false;
    const statements = new Map<string, StatementSync>();
    const stmt = (sql: string): StatementSync => {
        let statement = statements.get(sql);
        if (statement === undefined) {
            statement = db.prepare(sql);
            statements.set(sql, statement);
        }
        return statement;
    };

    const phoneForLid = (lid: string): string | undefined =>
        (stmt("SELECT phone FROM lid_map WHERE lid = ?").get(bareJid(lid)) as { phone?: string } | undefined)?.phone;
    const lidForPhone = (phone: string): string | undefined =>
        (stmt("SELECT lid FROM lid_map WHERE phone = ? LIMIT 1").get(bareJid(phone)) as { lid?: string } | undefined)?.lid;

    const mapLid = (lid: string, phone: string): void => {
        if (!isLidJid(lid) || !isPhoneJid(phone)) {
            return;
        }
        stmt("INSERT INTO lid_map (lid, phone) VALUES (?, ?) ON CONFLICT(lid) DO UPDATE SET phone = excluded.phone").run(bareJid(lid), bareJid(phone));
    };

    const upsertChat = (jid: string, name: string | null, lastAt: number | null): void => {
        stmt(
            `INSERT INTO chats (jid, name, kind, last_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(jid) DO UPDATE SET name = COALESCE(excluded.name, name), last_at = MAX(COALESCE(last_at, 0), COALESCE(excluded.last_at, 0))`,
        ).run(jid, name, isGroupJid(jid) ? "group" : "dm", lastAt);
    };

    const upsertContacts = (contacts: readonly ContactInput[]): void => {
        immediateTransaction(db, () => {
            for (const contact of contacts) {
                const id = bareJid(contact.id);
                if (ignoredChat(id)) {
                    continue;
                }
                // History sync lists every conversation as a "contact", groups included: a group's name is its subject.
                if (isGroupJid(id)) {
                    upsertChat(id, present(contact.name) ?? present(contact.notify), null);
                    continue;
                }
                const lid = present(contact.lid) ?? (isLidJid(id) ? id : null);
                const phone = present(contact.phoneNumber) ?? (isPhoneJid(id) ? id : null) ?? (lid === null ? null : (phoneForLid(lid) ?? null));
                const lidJid = lid === null ? null : bareJid(lid);
                const phoneJid = phone === null ? null : bareJid(phone);
                if (lidJid !== null && phoneJid !== null) {
                    mapLid(lidJid, phoneJid);
                }
                stmt(
                    `INSERT INTO contacts (jid, phone, lid, name, notify, verified, username) VALUES (?, ?, ?, ?, ?, ?, ?)
                     ON CONFLICT(jid) DO UPDATE SET
                        phone = COALESCE(excluded.phone, phone), lid = COALESCE(excluded.lid, lid),
                        name = COALESCE(excluded.name, name), notify = COALESCE(excluded.notify, notify),
                        verified = COALESCE(excluded.verified, verified), username = COALESCE(excluded.username, username)`,
                ).run(
                    phoneJid ?? lidJid ?? id,
                    phoneJid,
                    lidJid,
                    present(contact.name),
                    present(contact.notify),
                    present(contact.verifiedName),
                    present(contact.username),
                );
            }
        });
    };

    const upsertChats = (chats: readonly ChatInput[]): void => {
        immediateTransaction(db, () => {
            for (const chat of chats) {
                const jid = bareJid(chat.id);
                if (!ignoredChat(jid)) {
                    upsertChat(jid, present(chat.name), chat.lastAt ?? null);
                }
            }
        });
    };

    const addMessages = (messages: readonly StoredMessage[]): void => {
        if (messages.length === 0) {
            return;
        }
        const touched = new Set<string>();
        immediateTransaction(db, () => {
            for (const message of messages) {
                const chat = bareJid(message.chat);
                if (ignoredChat(chat) || message.id === "") {
                    continue;
                }
                // First write wins: a live message and the same one replayed by a later history sync are one message.
                stmt(
                    `INSERT OR IGNORE INTO messages (chat, id, from_me, author, author_name, text, ts, raw)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                ).run(chat, message.id, message.fromMe ? 1 : 0, message.author ?? null, message.authorName ?? null, message.text, message.ts, message.raw ?? null);
                upsertChat(chat, null, message.ts);
                touched.add(chat);
            }
            for (const chat of touched) {
                stmt(
                    `DELETE FROM messages WHERE chat = ? AND rowid NOT IN (
                        SELECT rowid FROM messages WHERE chat = ? ORDER BY ts DESC, rowid DESC LIMIT ?)`,
                ).run(chat, chat, MESSAGES_PER_CHAT);
            }
        });
    };

    const recent = (chat: string, limit: number, beforeTs?: number): MessageRow[] => {
        const rows = (
            beforeTs === undefined
                ? stmt("SELECT * FROM messages WHERE chat = ? ORDER BY ts DESC, rowid DESC LIMIT ?").all(bareJid(chat), limit)
                : stmt("SELECT * FROM messages WHERE chat = ? AND ts < ? ORDER BY ts DESC, rowid DESC LIMIT ?").all(bareJid(chat), beforeTs, limit)
        ) as unknown as RawMessageRow[];
        return rows.reverse().map(toMessage);
    };

    const directory = (): DirectoryEntry[] => {
        const lidToPhone = new Map<string, string>();
        const phoneToLid = new Map<string, string>();
        for (const row of stmt("SELECT lid, phone FROM lid_map").all() as unknown as { lid: string; phone: string }[]) {
            lidToPhone.set(row.lid, row.phone);
            phoneToLid.set(row.phone, row.lid);
        }
        const chats = new Map<string, ChatRow>();
        for (const row of stmt("SELECT * FROM chats").all() as unknown as ChatRow[]) {
            chats.set(row.jid, row);
        }

        interface Person {
            phone?: string;
            lid?: string;
            name?: string;
            chatName?: string;
            notify?: string;
            verified?: string;
            username?: string;
        }
        const people = new Map<string, Person>();
        const identify = (jid: string): { key: string; phone?: string; lid?: string } => {
            const phone = isPhoneJid(jid) ? jid : isLidJid(jid) ? lidToPhone.get(jid) : undefined;
            const lid = isLidJid(jid) ? jid : phone === undefined ? undefined : phoneToLid.get(phone);
            return { key: phone ?? lid ?? jid, ...(phone === undefined ? {} : { phone }), ...(lid === undefined ? {} : { lid }) };
        };
        const merge = (key: string, found: Person): void => {
            const known = people.get(key) ?? {};
            people.set(key, {
                ...found,
                ...Object.fromEntries(Object.entries(known).filter(([, value]) => value !== undefined)),
            });
        };
        for (const row of stmt("SELECT * FROM contacts").all() as unknown as ContactRow[]) {
            const seed = identify(row.phone ?? row.lid ?? row.jid);
            const lid = seed.lid ?? row.lid ?? undefined;
            merge(seed.key, {
                ...(seed.phone === undefined ? {} : { phone: seed.phone }),
                ...(lid === undefined ? {} : { lid }),
                ...(row.name === null ? {} : { name: row.name }),
                ...(row.notify === null ? {} : { notify: row.notify }),
                ...(row.verified === null ? {} : { verified: row.verified }),
                ...(row.username === null ? {} : { username: row.username }),
            });
        }
        const entries: DirectoryEntry[] = [];
        for (const chat of chats.values()) {
            if (chat.kind === "group") {
                entries.push({
                    jid: chat.jid,
                    kind: "group",
                    ...(chat.name === null ? {} : { chatName: chat.name }),
                    ...(chat.last_at === null || chat.last_at === 0 ? {} : { lastAt: chat.last_at }),
                });
                continue;
            }
            const seed = identify(chat.jid);
            merge(seed.key, {
                ...(seed.phone === undefined ? {} : { phone: seed.phone }),
                ...(seed.lid === undefined ? {} : { lid: seed.lid }),
                ...(chat.name === null ? {} : { chatName: chat.name }),
            });
        }
        for (const person of people.values()) {
            const lidChat = person.lid === undefined ? undefined : chats.get(person.lid);
            const phoneChat = person.phone === undefined ? undefined : chats.get(person.phone);
            // Address a person through the chat WhatsApp already keeps for them; a new one through their @lid.
            const jid = lidChat?.jid ?? phoneChat?.jid ?? person.lid ?? person.phone;
            if (jid === undefined) {
                continue;
            }
            const lastAt = Math.max(lidChat?.last_at ?? 0, phoneChat?.last_at ?? 0);
            entries.push({ jid, kind: "dm", ...person, ...(lastAt === 0 ? {} : { lastAt }) });
        }
        return entries;
    };

    const namesOf = (entry: DirectoryEntry): string[] =>
        [entry.name, entry.chatName, entry.notify, entry.verified, entry.username].filter((name): name is string => name !== undefined);

    // 0: a name equals the query; 1: every query word starts a word of one name; 2: a name or number contains it.
    const rank = (entry: DirectoryEntry, query: string, digits: string): number | undefined => {
        const names = namesOf(entry).map(foldName);
        if (names.includes(query)) {
            return 0;
        }
        const words = query.split(" ");
        if (names.some((name) => words.every((word) => name.split(" ").some((part) => part.startsWith(word))))) {
            return 1;
        }
        if (names.some((name) => name.includes(query))) {
            return 2;
        }
        if (digits.length >= 4 && [entry.phone, entry.jid].some((jid) => jid !== undefined && isPhoneJid(jid) && jidUser(jid).includes(digits))) {
            return 2;
        }
        return undefined;
    };

    const ranked = (text: string): { entry: DirectoryEntry; tier: number }[] => {
        const query = foldName(text);
        if (query === "") {
            return [];
        }
        const digits = /^\+?[\d\s().-]+$/.test(text.trim()) ? text.replaceAll(/\D/g, "") : "";
        return directory()
            .flatMap((entry) => {
                const tier = rank(entry, query, digits);
                return tier === undefined ? [] : [{ entry, tier }];
            })
            .toSorted((a, b) => a.tier - b.tier || (b.entry.lastAt ?? 0) - (a.entry.lastAt ?? 0));
    };

    const resolve = (text: string): Resolution => {
        const matches = ranked(text);
        if (matches.length === 0) {
            return { kind: "none" };
        }
        const best = matches[0]?.tier ?? 2;
        const top = matches.filter((match) => match.tier === best).map((match) => match.entry);
        // A loose substring hit is only taken when it is the sole hit of any kind.
        if (top.length === 1 && (best < 2 || matches.length === 1)) {
            return { kind: "found", entry: top[0] as DirectoryEntry };
        }
        return { kind: "ambiguous", candidates: matches.slice(0, 10).map((match) => match.entry) };
    };

    const nameOf = (jid: string): string | undefined => {
        const bare = bareJid(jid);
        const chat = stmt("SELECT name FROM chats WHERE jid = ?").get(bare) as { name?: string | null } | undefined;
        if (isGroupJid(bare)) {
            return chat?.name ?? undefined;
        }
        const phone = isPhoneJid(bare) ? bare : phoneForLid(bare);
        const lid = isLidJid(bare) ? bare : phone === undefined ? undefined : lidForPhone(phone);
        const rows = stmt("SELECT name, notify, verified FROM contacts WHERE jid IN (?, ?, ?) OR phone = ? OR lid = ?").all(
            bare,
            phone ?? "",
            lid ?? "",
            phone ?? "",
            lid ?? "",
        ) as unknown as { name: string | null; notify: string | null; verified: string | null }[];
        return (
            rows.find((row) => row.name !== null)?.name ??
            chat?.name ??
            rows.find((row) => row.notify !== null)?.notify ??
            rows.find((row) => row.verified !== null)?.verified ??
            undefined
        );
    };

    const chatForPhone = (phone: string, knownLid?: string): string => {
        const phoneJid = bareJid(phone);
        const lid = lidForPhone(phoneJid) ?? (knownLid === undefined ? undefined : bareJid(knownLid));
        const has = (jid: string): boolean => stmt("SELECT 1 AS hit FROM chats WHERE jid = ?").get(jid) !== undefined;
        if (lid !== undefined && has(lid)) {
            return lid;
        }
        if (has(phoneJid)) {
            return phoneJid;
        }
        return lid ?? phoneJid;
    };

    return {
        upsertContacts,
        upsertChats,
        mapLid: (lid, phone) => mapLid(lid, phone),
        phoneForLid,
        lidForPhone,
        addMessages,
        editMessage: (chat, id, text) => void stmt("UPDATE messages SET text = ? WHERE chat = ? AND id = ?").run(text, bareJid(chat), id),
        deleteMessage: (chat, id) => void stmt("UPDATE messages SET text = '[deleted]', raw = NULL WHERE chat = ? AND id = ?").run(bareJid(chat), id),
        recent,
        oldest: (chat) => {
            const row = stmt("SELECT * FROM messages WHERE chat = ? ORDER BY ts ASC, rowid ASC LIMIT 1").get(bareJid(chat)) as RawMessageRow | undefined;
            return row === undefined ? undefined : toMessage(row);
        },
        countIn: (chat) => (stmt("SELECT COUNT(*) AS n FROM messages WHERE chat = ?").get(bareJid(chat)) as { n: number }).n,
        message: (id, chat) => {
            const row = (
                chat === undefined
                    ? stmt("SELECT * FROM messages WHERE id = ? ORDER BY ts DESC LIMIT 1").get(id)
                    : stmt("SELECT * FROM messages WHERE id = ? AND chat = ?").get(id, bareJid(chat))
            ) as RawMessageRow | undefined;
            return row === undefined ? undefined : toMessage(row);
        },
        directory,
        search: (query) => ranked(query).map((match) => match.entry),
        resolve,
        nameOf,
        chatForPhone,
        contactCount: () => (stmt("SELECT COUNT(*) AS n FROM contacts").get() as { n: number }).n,
        meta: (key) => (stmt("SELECT value FROM meta WHERE key = ?").get(key) as { value?: string } | undefined)?.value,
        setMeta: (key, value) => void stmt("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value),
        close: () => {
            if (!closed) {
                closed = true;
                db.close();
            }
        },
    };
};
