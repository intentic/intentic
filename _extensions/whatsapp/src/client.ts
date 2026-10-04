import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Backoff, createBackoff, serialLock } from "@intentic/base/async";
import { errorMessage, undefinedIfMissing } from "@intentic/base/errors";
// oxlint-disable-next-line import/no-named-as-default -- Baileys exports the factory in both forms.
import makeWASocket, {
    Browsers,
    BufferJSON,
    type ConnectionState,
    type LTHashState,
    DisconnectReason,
    downloadMediaMessage,
    fetchLatestWaWebVersion,
    jidNormalizedUser,
    useMultiFileAuthState,
    type AnyMessageContent,
    type MiscMessageGenerationOptions,
    type WAMessage,
    type WAMessageKey,
    type WAVersion,
} from "baileys";
import type { ListenerPairing } from "@intentic/sandbox-contract";
import type { Logger } from "@intentic/connector-runtime";
import { bareJid, isGroupJid, jidUser } from "./content.js";
import { toWhatsAppText } from "./format.js";
import { fileContentOf, mediaNameOf, VOICE_MIME, voiceNoteOf } from "./media.js";
import { awaitPairingAnswer } from "./pairing.js";
import { type DirectoryEntry, type MessageRow, openWaStore, type WaStore } from "./store.js";
import { type ChatTarget, createStoreSync, recentOf, resolveChatIn, type Sender, senderOf, type StoreSync } from "./sync.js";
import type { WaRawMessage } from "./types.js";

export type { ChatTarget, Sender } from "./sync.js";

// Module singleton map of WhatsApp connections, one socket per capability, alive while its listener or CLI connector
// exists. Only this file imports baileys; the rest of the package uses the structural types in types.ts. `open()`
// resumes a registered session or requests a pairing code, reporting waiting, code, and failed states via `pairing()`.
// Everything the account tells the device (contacts, chats, messages) goes into the session's store (store.ts).

// Reconnect backoff for ordinary closes; pairing-phase closes reuse it too, each recreate mints a fresh code.
const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 60_000;
// WhatsApp answers a link-code request within a second; past this the code is shown unconfirmed rather than withheld.
const PAIRING_ANSWER_MS = 15_000;
// How long a fetched WhatsApp Web version is reused before asking again, and how long one ask may take.
const VERSION_TTL_MS = 6 * 60 * 60_000;
const VERSION_FETCH_MS = 10_000;
// A send WhatsApp never confirms (a media upload stalled, a socket half-dead) frees the queue after this, so one stuck
// message cannot hold every later one; a hang bound, not a latency budget.
const SEND_TIMEOUT_MS = 60_000;
// How long `history` waits for the phone to answer a request for older messages; the phone must be online to answer.
const HISTORY_WAIT_MS = 20_000;
// WhatsApp serves at most this many messages per on-demand history request.
const HISTORY_PAGE_MAX = 50;
// After connecting, how long the contact-book recovery waits so it does not race the connection's own initial queries.
const RECOVERY_DELAY_MS = 15_000;
// The store file inside the session dir: unlinking wipes that dir, and takes what the account told the device with it.
const STORE_FILE = "intentic-store.db";
// The app-state collection WhatsApp keeps the owner's saved contacts in.
const CONTACTS_COLLECTION = "critical_unblock_low";
// Set once the store holds the address book: from the first sync after pairing, or from the recovery resync.
const CONTACTS_SYNCED = "contacts_synced_at";
const EXHAUSTED = "history_exhausted:";

// The identity this device presents. WhatsApp checks the link-code request's "<browser> (<os>)" display against real
// browsers and systems: a made-up OS like "intentic" is refused with 400 bad-request, and the phone then reports
// "Couldn't link device" for the code. So the device presents as Chrome on Ubuntu, a pair WhatsApp accepts.
const BROWSER = Browsers.ubuntu("Chrome");

export type ConnectionPhase = "pairing" | "connecting" | "ready";

// How a history read went: the store already held enough, the phone sent older messages (or had none), the phone did
// not answer in time, or there was no message to count back from.
export type HistoryFetch = "stored" | "answered" | "timeout" | "no-anchor";

export interface WhatsAppConnection {
    readonly capabilityId: string;
    // This session's own identities once connected; phone JID always, @lid identity when WhatsApp assigns one.
    readonly selfJid: () => string | undefined;
    readonly selfLid: () => string | undefined;
    readonly phase: () => ConnectionPhase;
    // Where the link-a-device ceremony stands, or undefined once this session is paired.
    readonly pairing: () => ListenerPairing | undefined;
    readonly sendText: (chat: string, text: string, quotedId?: string) => Promise<void>;
    readonly sendFile: (chat: string, path: string) => Promise<void>;
    readonly sendVoice: (chat: string, path: string) => Promise<void>;
    readonly react: (chat: string, messageId: string, emoji: string) => Promise<void>;
    readonly presence: (chat: string, state: "composing" | "paused") => Promise<void>;
    // Every person and group the store knows, groups refreshed from WhatsApp first; most recently active first.
    readonly listChats: () => Promise<DirectoryEntry[]>;
    readonly searchContacts: (query: string) => DirectoryEntry[];
    readonly resolveChat: (target: string) => Promise<ChatTarget>;
    readonly sender: (raw: WaRawMessage) => Promise<Sender>;
    readonly nameOf: (jid: string) => string | undefined;
    // The chat's last `limit` messages, oldest first, without the one with id `exclude`.
    readonly recent: (chat: string, limit: number, exclude?: string) => MessageRow[];
    // Like recent, but asks the phone for older messages first when the store holds fewer than `limit`.
    readonly history: (chat: string, limit: number) => Promise<{ readonly messages: MessageRow[]; readonly fetch: HistoryFetch }>;
    // Fetches and decrypts a stored message's media into destDir; undefined if the id is unknown or has no media.
    readonly download: (id: string, destDir: string) => Promise<string | undefined>;
}

const connections = new Map<string, WhatsAppConnection>();
// close drops the socket and keeps the session; logout unlinks the device and needs the live socket.
const closers = new Map<string, { close: () => void; logout: () => Promise<void> }>();

export const whatsappConnection = (capabilityId: string): WhatsAppConnection | undefined => connections.get(capabilityId);
export const whatsappConnections = (): ReadonlyMap<string, WhatsAppConnection> => connections;

export interface OpenOptions {
    readonly capabilityId: string;
    readonly phoneNumber: string;
    readonly sessionDir: string;
    readonly log: Logger;
    readonly onMessage: (message: WaRawMessage) => void;
    // Session ended for good; the session dir and pool entry are already gone, so the next reconcile re-pairs.
    readonly onLoggedOut: (detail: string) => void;
}

type Socket = ReturnType<typeof makeWASocket>;
type Auth = Awaited<ReturnType<typeof useMultiFileAuthState>>;

// One connection's state: fixed parts first, then what each socket recreate and connection event moves.
interface Session {
    readonly options: OpenOptions;
    readonly auth: Auth;
    readonly store: WaStore;
    readonly sync: StoreSync;
    readonly ladder: Backoff;
    // One send at a time on the socket: concurrent sendMessage calls on one Baileys socket have misrouted messages
    // between chats (hermes-agent #33360), and the CLI, the daemon's deliver door and mention replies all send.
    readonly sendLock: <T>(task: () => Promise<T>) => Promise<T>;
    // Callers waiting for the phone's answer to an on-demand history request, by chat.
    readonly historyWaiters: Map<string, Set<() => void>>;
    // Live socket everything acts through; reassigned on every recreate, so nothing may capture it.
    sock: Socket | undefined;
    phase: ConnectionPhase;
    // Undefined once linked; every other moment is one of the three pairing states.
    pairing: ListenerPairing | undefined;
    selfJid: string | undefined;
    selfLid: string | undefined;
    closed: boolean;
}

// Baileys wants digits only ("4915112345678"), people write numbers with +, spaces and dashes.
const digitsOf = (phoneNumber: string): string => phoneNumber.replaceAll(/\D/g, "");

// No-op pino-shaped logger; structural, cast at the boundary instead of depending on pino.
const silentLogger = {
    level: "silent",
    child: (): object => silentLogger,
    trace: (): void => undefined,
    debug: (): void => undefined,
    info: (): void => undefined,
    warn: (): void => undefined,
    error: (): void => undefined,
};
// SAFETY: baileys types its logger as pino's ILogger; every method it calls on one is defined above as a no-op.
const BAILEYS_LOGGER = silentLogger as never;

// Stored form of a raw message: Buffers as base64 (BufferJSON), and for messages others sent, without the inline
// thumbnail, the one field that makes a photo's row kilobytes. Our own sends stay whole: WhatsApp's retry asks for
// them back exactly.
const withoutThumbnail = (key: string, value: Parameters<typeof BufferJSON.replacer>[1]): ReturnType<typeof BufferJSON.replacer> =>
    key === "jpegThumbnail" ? undefined : BufferJSON.replacer(key, value);
const serialize = (raw: WaRawMessage, own: boolean): string => JSON.stringify(raw, own ? BufferJSON.replacer : withoutThumbnail);
// SAFETY: the store only ever holds what serialize() wrote, and serialize() only ever receives baileys' WAMessages.
const deserialize = (text: string): WAMessage => JSON.parse(text, BufferJSON.reviver) as WAMessage;

// Rejects with `message` when `promise` has not settled within `ms`; the promise itself keeps running.
const withTimeout = async <T>(promise: Promise<T>, ms: number, message: string): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(message)), ms);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
};

// The WhatsApp Web version to advertise. WhatsApp refuses to finish linking a device that advertises a stale one
// (Baileys #2679), and the default baked into baileys ages with every month no release ships; undefined keeps that
// default when web.whatsapp.com cannot be asked.
let versionCache: { readonly version: WAVersion; readonly at: number } | undefined;
const webVersion = async (log: Logger): Promise<WAVersion | undefined> => {
    if (versionCache !== undefined && Date.now() - versionCache.at < VERSION_TTL_MS) {
        return versionCache.version;
    }
    const latest = await fetchLatestWaWebVersion({ signal: AbortSignal.timeout(VERSION_FETCH_MS) });
    if (!latest.isLatest) {
        log.warn({ err: latest.error }, "whatsapp web version lookup failed; advertising the last known one");
        return versionCache?.version;
    }
    versionCache = { version: latest.version, at: Date.now() };
    return latest.version;
};

// Whether a session dir holds a session worth resuming, rather than leftovers from an unfinished pairing. Only a missing
// creds file means nothing to resume: a read that failed throws, because the caller wipes whatever this calls unpaired.
const sessionRegistered = async (sessionDir: string, log: Logger, capabilityId: string): Promise<boolean> => {
    const raw = await readFile(join(sessionDir, "creds.json"), "utf8").catch(undefinedIfMissing);
    if (raw === undefined) {
        return false;
    }
    try {
        return (JSON.parse(raw) as { registered?: unknown }).registered === true;
    } catch (error) {
        // Torn creds hold no identity baileys could resume from; the session is lost either way, and said so here.
        log.warn({ err: error, capabilityId, sessionDir }, "whatsapp session creds do not parse; starting a fresh pairing");
        return false;
    }
};

// Baileys' own LID map, read from the session's key files without asking the network (getLIDForPN would): the phone
// user's entry holds the @lid user, and "<lid user>_reverse" holds the phone user.
const lidFromKeys = async (session: Session, phoneJid: string): Promise<string | undefined> => {
    const user = jidUser(phoneJid);
    const stored = session.store.lidForPhone(phoneJid) ?? (await session.auth.state.keys.get("lid-mapping", [user]))[user];
    if (stored === undefined || stored === "") {
        return undefined;
    }
    return stored.includes("@") ? stored : `${stored}@lid`;
};
const phoneFromKeys = async (session: Session, lid: string): Promise<string | undefined> => {
    const reverse = `${jidUser(lid)}_reverse`;
    const stored = (await session.auth.state.keys.get("lid-mapping", [reverse]))[reverse];
    if (stored === undefined || stored === "") {
        return undefined;
    }
    const phone = `${stored}@s.whatsapp.net`;
    session.store.mapLid(bareJid(lid), phone);
    return phone;
};

const liveSocket = (session: Session): Socket => {
    if (session.sock === undefined || session.phase !== "ready") {
        throw new Error("WhatsApp is not connected: pair the device from the capability card first");
    }
    return session.sock;
};

const sendVia = (session: Session, jid: string, content: AnyMessageContent, extra?: MiscMessageGenerationOptions): Promise<void> =>
    session.sendLock(async () => {
        const sent = await withTimeout(
            liveSocket(session).sendMessage(jid, content, extra),
            SEND_TIMEOUT_MS,
            `WhatsApp did not confirm the message to ${jid} within ${SEND_TIMEOUT_MS / 1_000}s; it may still arrive`,
        );
        // Kept so a retry request from the recipient's phone, minutes or hours later, can still be answered.
        if (sent !== undefined) {
            session.sync.messages([sent]);
        }
    });

const storedRaw = (session: Session, id: string, chat?: string): WAMessage | undefined => {
    const raw = session.store.message(id, chat)?.raw;
    return raw === undefined ? undefined : deserialize(raw);
};

// The key a reaction names: in a group, the author of the message, which only a stored message can tell.
const reactionKey = (session: Session, chat: string, messageId: string): WAMessageKey => {
    const row = session.store.message(messageId, chat);
    const fromMe = row?.fromMe ?? false;
    const key = { remoteJid: chat, id: messageId, fromMe };
    if (!isGroupJid(chat) || fromMe) {
        return key;
    }
    if (row?.author === undefined) {
        throw new Error(`Message ${messageId} is not in this chat's stored history, and a reaction in a group must name who wrote it`);
    }
    return { ...key, participant: row.author };
};

// Resolves once the phone's answer to an on-demand history request lands for this chat; false after `ms` without one.
const awaitHistory = (session: Session, chat: string, ms: number): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
        const waiters = session.historyWaiters.get(chat) ?? new Set<() => void>();
        session.historyWaiters.set(chat, waiters);
        const timer = setTimeout(() => {
            waiters.delete(done);
            resolve(false);
        }, ms);
        function done(): void {
            clearTimeout(timer);
            waiters.delete(done);
            resolve(true);
        }
        waiters.add(done);
    });

// Asks the phone for messages older than the oldest one stored, and waits for its answer.
const fetchOlder = async (session: Session, chat: string, count: number): Promise<HistoryFetch> => {
    const { store } = session;
    const anchor = store.oldest(chat);
    if (anchor === undefined) {
        return "no-anchor";
    }
    const answered = awaitHistory(session, chat, HISTORY_WAIT_MS);
    const before = store.countIn(chat);
    // The proto field is oldestMsgTimestampMs: milliseconds, whatever Baileys' README example passes.
    await liveSocket(session).fetchMessageHistory(count, { remoteJid: chat, id: anchor.id, fromMe: anchor.fromMe }, anchor.ts * 1_000);
    if (!(await answered)) {
        return "timeout";
    }
    // The phone answered with nothing older: this chat's start is already stored, so never ask for it again.
    if (store.countIn(chat) === before) {
        store.setMeta(`${EXHAUSTED}${chat}`, String(Date.now()));
    }
    return "answered";
};

// The owner's saved contacts reach a linked device once, in the first app-state sync after pairing. A session that
// synced before this store existed lost them; re-reading that one collection from a snapshot brings them back. Never
// throws: a failure is logged, and the next connect tries again.
const recoverContactBook = async (session: Session, socket: Socket): Promise<void> => {
    const { auth, store, options } = session;
    if (store.meta(CONTACTS_SYNCED) !== undefined || (auth.state.creds.accountSyncCounter ?? 0) === 0 || session.sock !== socket || session.phase !== "ready") {
        return;
    }
    const versionOf = async (): Promise<LTHashState | null | undefined> => (await auth.state.keys.get("app-state-sync-version", [CONTACTS_COLLECTION]))[CONTACTS_COLLECTION];
    const before = store.contactCount();
    let saved: LTHashState | null | undefined;
    let failure: unknown;
    try {
        saved = await versionOf();
        // With no version on record, the resync asks for the whole collection as a snapshot, the way WhatsApp Web
        // recovers a collection it cannot trust.
        await auth.state.keys.set({ "app-state-sync-version": { [CONTACTS_COLLECTION]: null } });
        await socket.resyncAppState([CONTACTS_COLLECTION], false);
    } catch (error) {
        failure = error;
    }
    let now: LTHashState | null | undefined;
    try {
        now = await versionOf();
    } catch (error) {
        // Reported with the warning below, as the reason the recovery did not complete.
        failure ??= error;
    }
    if (now === undefined || now === null) {
        // The snapshot did not land (a missing key, a refused request): put the old version back so ordinary contact
        // updates keep flowing, and try again on the next connect.
        if (saved !== undefined && saved !== null) {
            try {
                await auth.state.keys.set({ "app-state-sync-version": { [CONTACTS_COLLECTION]: saved } });
            } catch (error) {
                options.log.error({ err: error, capabilityId: options.capabilityId }, "whatsapp could not restore the contacts collection's sync version");
            }
        }
        options.log.warn({ err: failure, capabilityId: options.capabilityId }, "whatsapp contact book recovery did not complete; retrying on the next connect");
        return;
    }
    store.setMeta(CONTACTS_SYNCED, String(Date.now()));
    options.log.info({ capabilityId: options.capabilityId, before, after: store.contactCount() }, "whatsapp contact book recovered");
};

// The account's own events, into the store. A store write that throws must not take the socket's event loop down with
// it; it is logged and that event lost.
const wireStore = (session: Session, socket: Socket): void => {
    const { sync, store, options } = session;
    const guarded =
        <T>(what: string, apply: (value: T) => void) =>
        (value: T): void => {
            try {
                apply(value);
            } catch (error) {
                options.log.error({ err: error, capabilityId: options.capabilityId }, `whatsapp store: ${what} failed`);
            }
        };
    socket.ev.on("contacts.upsert", guarded("contacts", sync.contacts));
    socket.ev.on(
        "contacts.update",
        guarded("contact updates", (updates) => sync.contacts(updates.flatMap((update) => (update.id === undefined ? [] : [{ ...update, id: update.id }])))),
    );
    socket.ev.on("chats.upsert", guarded("chats", sync.chats));
    socket.ev.on("chats.update", guarded("chat updates", sync.chats));
    socket.ev.on("groups.upsert", guarded("groups", sync.groups));
    socket.ev.on("groups.update", guarded("group updates", sync.groups));
    socket.ev.on("lid-mapping.update", guarded("lid mapping", sync.lidMapping));
    socket.ev.on("messages.upsert", guarded("messages", ({ messages }) => sync.messages(messages)));
    socket.ev.on(
        "messaging-history.set",
        guarded("history", (set) => {
            const touched = new Set(sync.history(set));
            for (const chat of set.chats) {
                touched.add(bareJid(chat.id ?? ""));
            }
            for (const chat of touched) {
                for (const wake of session.historyWaiters.get(chat) ?? []) {
                    wake();
                }
            }
        }),
    );
    // The first sync after pairing has finished, address book included (its events flush before this one).
    socket.ev.on("creds.update", (update) => {
        if (update.accountSyncCounter !== undefined && store.meta(CONTACTS_SYNCED) === undefined) {
            store.setMeta(CONTACTS_SYNCED, String(Date.now()));
        }
    });
};

// `qr` signals the socket is ready to pair; a phone-number code is requested instead of ever rendering the QR. The code
// is shown only once WhatsApp has not refused it; see pairing.ts for why baileys alone cannot say.
const requestPairing = (session: Session, socket: Socket): void => {
    const { options } = session;
    const reply = awaitPairingAnswer(socket.ws, PAIRING_ANSWER_MS);
    void socket
        .requestPairingCode(digitsOf(options.phoneNumber))
        .then(async (code) => {
            const answer = await reply.answer;
            // A socket that closed meanwhile was replaced, and its code died with it.
            if (session.sock === socket) {
                session.pairing = { state: "code", code, since: Date.now() };
                options.log.info({ capabilityId: options.capabilityId, answer }, "pairing code issued");
            }
        })
        .catch((error: Error) => {
            reply.cancel();
            if (session.sock === socket) {
                // A refused number is surfaced to the owner via `pairing`, not just logged.
                session.pairing = { state: "failed", detail: errorMessage(error) };
                options.log.warn({ err: error, capabilityId: options.capabilityId }, "pairing code request failed");
            }
        });
};

const onOpen = (session: Session, socket: Socket): void => {
    session.phase = "ready";
    session.pairing = undefined;
    session.ladder.reset();
    const me = socket.user;
    session.selfJid = me?.id === undefined ? undefined : jidNormalizedUser(me.id);
    session.selfLid = me?.lid === undefined || me.lid === "" ? undefined : jidNormalizedUser(me.lid);
    session.options.log.info({ capabilityId: session.options.capabilityId, selfJid: session.selfJid }, "whatsapp connected");
    setTimeout(() => void recoverContactBook(session, socket), RECOVERY_DELAY_MS).unref();
};

// The status code a close carries, or 0 when it carries none.
const closeCodeOf = (update: Partial<ConnectionState>): number =>
    // SAFETY: baileys ends a connection with Boom errors, which keep the status under output.statusCode; the optional
    // chain reads anything else as no code.
    (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode ?? 0;

const onClose = (session: Session, update: Partial<ConnectionState>): void => {
    if (session.closed) {
        return;
    }
    const { options, auth } = session;
    const code = closeCodeOf(update);
    if (code === Number(DisconnectReason.loggedOut)) {
        // Phone unlinked or number gone; wipe the dead session so the next reconcile starts a fresh pairing.
        session.closed = true;
        connections.delete(options.capabilityId);
        closers.delete(options.capabilityId);
        session.store.close();
        void rm(options.sessionDir, { recursive: true, force: true }).finally(() =>
            options.onLoggedOut("WhatsApp unlinked this device: a fresh pairing code will appear on the capability card"),
        );
        return;
    }
    // restartRequired (515) is normal right after pairing succeeds; reconnect immediately.
    const rung = session.ladder.next();
    const wait = code === Number(DisconnectReason.restartRequired) ? 0 : rung;
    session.phase = auth.state.creds.registered ? "connecting" : "pairing";
    // A code dies with the socket that minted it; clear it rather than leave a dead code reading as live.
    if (session.phase === "pairing" && session.pairing?.state === "code") {
        session.pairing = { state: "waiting" };
    }
    setTimeout(() => void startSocket(session), wait);
};

const startSocket = async (session: Session): Promise<void> => {
    const { auth, store, options } = session;
    // Asked before the socket exists: a close() that lands meanwhile finds nothing to end, and stops this here.
    const version = await webVersion(options.log);
    if (session.closed) {
        return;
    }
    const socket = makeWASocket({
        auth: auth.state,
        logger: BAILEYS_LOGGER,
        browser: BROWSER,
        ...(version === undefined ? {} : { version }),
        markOnlineOnConnect: false,
        syncFullHistory: false,
        // A recipient's phone that failed to decrypt asks for the message again; Baileys keeps sends for five
        // minutes, the store keeps them for as long as the chat's log does.
        getMessage: async (key) => {
            const row = key.id === undefined || key.id === null ? undefined : store.message(key.id, key.remoteJid ?? undefined);
            return row?.raw === undefined ? undefined : (deserialize(row.raw).message ?? undefined);
        },
    });
    session.sock = socket;
    session.phase = auth.state.creds.registered ? "connecting" : "pairing";
    // A fresh socket means a new code, unless the last attempt failed; that state must survive retries.
    if (session.phase === "pairing" && session.pairing?.state !== "failed") {
        session.pairing = { state: "waiting" };
    }
    let pairingRequested = false;

    // A save that failed leaves the session on disk behind the one in memory; the next update retries it.
    socket.ev.on("creds.update", () => void auth.saveCreds().catch((error: Error) => options.log.error({ err: error, capabilityId: options.capabilityId }, "whatsapp creds save failed")));
    wireStore(session, socket);
    socket.ev.on("connection.update", (update) => {
        if (update.qr !== undefined && !auth.state.creds.registered && !pairingRequested) {
            pairingRequested = true;
            requestPairing(session, socket);
        }
        if (update.connection === "open") {
            onOpen(session, socket);
        } else if (update.connection === "close") {
            onClose(session, update);
        }
    });
    socket.ev.on("messages.upsert", ({ messages, type }) => {
        // Every kind is stored (wireStore), but only `notify` is live traffic; the others must not trigger anything.
        if (type !== "notify") {
            return;
        }
        for (const message of messages) {
            const chat = message.key.remoteJid;
            if (chat !== undefined && chat !== null && chat !== "status@broadcast") {
                options.onMessage(message);
            }
        }
    });
};

const sendApi = (session: Session): Pick<WhatsAppConnection, "sendText" | "sendFile" | "sendVoice" | "react" | "presence"> => ({
    sendText: async (chat, text, quotedId) => {
        const quoted = quotedId === undefined ? undefined : storedRaw(session, quotedId, chat);
        await sendVia(session, chat, { text: toWhatsAppText(text) }, quoted === undefined ? undefined : { quoted });
    },
    sendFile: async (chat, path) => sendVia(session, chat, await fileContentOf(path)),
    sendVoice: async (chat, path) => sendVia(session, chat, { audio: await voiceNoteOf(path), mimetype: VOICE_MIME, ptt: true }),
    react: async (chat, messageId, emoji) => sendVia(session, chat, { react: { text: emoji, key: reactionKey(session, chat, messageId) } }),
    presence: async (chat, state) => liveSocket(session).sendPresenceUpdate(state, chat),
});

const readApi = (session: Session): Omit<WhatsAppConnection, keyof ReturnType<typeof sendApi> | "capabilityId" | "selfJid" | "selfLid" | "phase" | "pairing"> => {
    const { store, sync } = session;
    return {
        listChats: async () => {
            // Group subjects come fresh from WhatsApp; a failed read throws, since answering with the store alone could
            // list groups this number has left.
            sync.groups(Object.values(await liveSocket(session).groupFetchAllParticipating()));
            return store.directory().toSorted((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0));
        },
        searchContacts: (query) => store.search(query),
        resolveChat: (target) => resolveChatIn(store, target, (phone) => lidFromKeys(session, phone)),
        sender: (raw) => senderOf(store, raw, (lid) => phoneFromKeys(session, lid)),
        nameOf: (jid) => store.nameOf(jid),
        recent: (chat, limit, exclude) => recentOf(store, chat, limit, exclude),
        history: async (chat, limit) => {
            const stored = store.countIn(chat);
            const enough = stored >= limit || store.meta(`${EXHAUSTED}${chat}`) !== undefined;
            const fetch = enough ? "stored" : await fetchOlder(session, chat, Math.min(HISTORY_PAGE_MAX, limit - stored));
            return { messages: store.recent(chat, limit), fetch };
        },
        download: async (id, destDir) => {
            const raw = storedRaw(session, id);
            const name = raw === undefined ? undefined : mediaNameOf(raw);
            if (raw === undefined || name === undefined) {
                return undefined;
            }
            // An old message's media may have expired on WhatsApp's servers; the phone is asked to upload it again.
            const socket = liveSocket(session);
            const buffer = await downloadMediaMessage(raw, "buffer", {}, { reuploadRequest: socket.updateMediaMessage, logger: BAILEYS_LOGGER });
            await mkdir(destDir, { recursive: true });
            const path = join(destDir, `${id}-${name}`);
            await writeFile(path, buffer);
            return path;
        },
    };
};

export const openWhatsAppConnection = async (options: OpenOptions): Promise<WhatsAppConnection> => {
    const { capabilityId, sessionDir, log } = options;
    // A stored session is kept only once the phone completed pairing; otherwise it's wiped and restarted clean.
    if (!(await sessionRegistered(sessionDir, log, capabilityId))) {
        await rm(sessionDir, { recursive: true, force: true });
    }
    await mkdir(sessionDir, { recursive: true });
    const auth = await useMultiFileAuthState(sessionDir);
    const store = openWaStore(join(sessionDir, STORE_FILE));
    const session: Session = {
        options,
        auth,
        store,
        sync: createStoreSync(store, serialize),
        ladder: createBackoff({ floorMs: RETRY_MIN_MS, capMs: RETRY_MAX_MS }),
        sendLock: serialLock(),
        historyWaiters: new Map(),
        sock: undefined,
        phase: "connecting",
        pairing: auth.state.creds.registered ? undefined : { state: "waiting" },
        selfJid: undefined,
        selfLid: undefined,
        closed: false,
    };
    const connection: WhatsAppConnection = {
        capabilityId,
        selfJid: () => session.selfJid,
        selfLid: () => session.selfLid,
        phase: () => session.phase,
        pairing: () => session.pairing,
        ...sendApi(session),
        ...readApi(session),
    };
    connections.set(capabilityId, connection);
    closers.set(capabilityId, {
        close: () => {
            session.closed = true;
            // end() drops the socket without touching the session; logout is reserved for forget().
            session.sock?.end(undefined);
            store.close();
        },
        logout: async () => {
            if (session.sock !== undefined && session.phase === "ready") {
                await session.sock.logout();
            }
        },
    });
    await startSocket(session);
    return connection;
};

// Drops the socket and keeps the session, for a reconcile close; the next open resumes without re-pairing.
export const closeWhatsAppConnection = (capabilityId: string): void => {
    connections.delete(capabilityId);
    closers.get(capabilityId)?.close();
    closers.delete(capabilityId);
};

// Unlinks and wipes the session for a removed connector, so a future re-add starts a fresh pairing.
export const forgetWhatsAppConnection = async (capabilityId: string, sessionDir: string, log: Logger): Promise<void> => {
    const closer = closers.get(capabilityId);
    connections.delete(capabilityId);
    closers.delete(capabilityId);
    // Best-effort: reaching the phone needs the socket that is about to die anyway.
    await closer?.logout().catch((error: unknown) => log.warn({ err: error }, "whatsapp logout failed"));
    closer?.close();
    await rm(sessionDir, { recursive: true, force: true });
};
