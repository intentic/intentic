import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { createBackoff } from "@intentic/base/async";
import { errorMessage } from "@intentic/base/errors";
// oxlint-disable-next-line import/no-named-as-default -- baileys exports the socket factory as BOTH its default and a same-named named export; the default is the documented import.
import makeWASocket, { DisconnectReason, downloadMediaMessage, jidNormalizedUser, useMultiFileAuthState } from "baileys";
import type { ListenerPairing } from "@intentic/sandbox-contract";
import type { Logger } from "@intentic/connector-runtime";
import type { WaRawMessage } from "./types.js";

// Module singleton map of WhatsApp connections, one socket per capability, alive while its listener or CLI connector
// exists. Only this file imports baileys; the rest of the package uses the structural types in types.ts. `open()`
// resumes a registered session or requests a pairing code, reporting waiting, code, and failed states via `pairing()`.

// Reconnect backoff for ordinary closes; pairing-phase closes reuse it too, each recreate mints a fresh code.
const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 60_000;
// Raw messages cached for media download and reply quoting; media decrypts only from its original envelope.
const RAW_CACHE_MAX = 500;

export type ConnectionPhase = "pairing" | "connecting" | "ready";

export interface ChatEntry {
    readonly jid: string;
    readonly name: string;
    readonly kind: "group" | "dm";
}

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
    readonly presence: (chat: string, state: "composing" | "paused") => Promise<void>;
    readonly listChats: () => Promise<ChatEntry[]>;
    // Fetches and decrypts a cached message's media into destDir; undefined if the id aged out or has no media.
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

// The file extension for a downloaded medium, derived from its declared mimetype.
const extensionOf = (mimetype: string | undefined): string => {
    const subtype = mimetype?.split("/")[1]?.split(";")[0]?.trim();
    return subtype === undefined || subtype === "" ? "bin" : subtype.replace("jpeg", "jpg");
};

// Extensions sendFile sends as an image; everything else goes as a document with its filename intact.
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

// Whether a session dir holds a session worth resuming, rather than leftovers from an unfinished pairing. A missing or
// unreadable creds file reads as nothing to resume.
const sessionRegistered = async (sessionDir: string): Promise<boolean> => {
    const raw = await readFile(join(sessionDir, "creds.json"), "utf8").catch(() => undefined);
    if (raw === undefined) {
        return false;
    }
    try {
        return (JSON.parse(raw) as { registered?: unknown }).registered === true;
    } catch {
        return false;
    }
};

export const openWhatsAppConnection = async (options: OpenOptions): Promise<WhatsAppConnection> => {
    const { capabilityId, sessionDir, log } = options;
    const phone = digitsOf(options.phoneNumber);
    // A stored session is kept only once the phone completed pairing; otherwise it's wiped and restarted clean.
    if (!(await sessionRegistered(sessionDir))) {
        await rm(sessionDir, { recursive: true, force: true });
    }
    await mkdir(sessionDir, { recursive: true });
    const auth = await useMultiFileAuthState(sessionDir);

    // Live socket the closures act through; reassigned on every recreate, so nothing may capture it.
    let sock: ReturnType<typeof makeWASocket> | undefined;
    let phase: ConnectionPhase = "connecting";
    // Undefined once linked; every other moment is one of the three pairing states.
    let pairing: ListenerPairing | undefined = auth.state.creds.registered ? undefined : { state: "waiting" };
    let selfJid: string | undefined;
    let selfLid: string | undefined;
    let closed = false;
    const ladder = createBackoff({ floorMs: RETRY_MIN_MS, capMs: RETRY_MAX_MS });

    // Recent raw messages by id, needed to decrypt downloads and quote replies; chats seen so far, since WhatsApp has
    // no on-demand DM list.
    const rawCache = new Map<string, WaRawMessage>();
    const seenChats = new Map<string, { name: string; kind: "group" | "dm" }>();

    const remember = (message: WaRawMessage): void => {
        const id = message.key.id;
        if (id === undefined || id === null) {
            return;
        }
        rawCache.delete(id);
        rawCache.set(id, message);
        if (rawCache.size > RAW_CACHE_MAX) {
            const oldest = rawCache.keys().next().value;
            if (oldest !== undefined) {
                rawCache.delete(oldest);
            }
        }
    };

    const live = (): ReturnType<typeof makeWASocket> => {
        if (sock === undefined || phase !== "ready") {
            throw new Error("WhatsApp is not connected: pair the device from the capability card first");
        }
        return sock;
    };

    const start = (): void => {
        if (closed) {
            return;
        }
        const socket = makeWASocket({
            auth: auth.state,
            logger: silentLogger as never,
            // Name shown for this device in the phone's Linked Devices list.
            browser: ["intentic", "Chrome", "1.0"],
            markOnlineOnConnect: false,
            syncFullHistory: false,
        });
        sock = socket;
        phase = auth.state.creds.registered ? "connecting" : "pairing";
        // A fresh socket means a new code, unless the last attempt failed; that state must survive retries.
        if (phase === "pairing" && pairing?.state !== "failed") {
            pairing = { state: "waiting" };
        }
        let pairingRequested = false;

        socket.ev.on("creds.update", () => void auth.saveCreds());
        socket.ev.on("connection.update", (update) => {
            // `qr` signals the socket is ready to pair; request a phone-number code instead of ever rendering the QR.
            if (update.qr !== undefined && !auth.state.creds.registered && !pairingRequested) {
                pairingRequested = true;
                void socket
                    .requestPairingCode(phone)
                    .then((code) => {
                        pairing = { state: "code", code, since: Date.now() };
                        log.info({ capabilityId }, "pairing code issued");
                    })
                    .catch((error: unknown) => {
                        // A refused number is surfaced to the owner via `pairing`, not just logged.
                        pairing = { state: "failed", detail: errorMessage(error) };
                        log.warn({ err: error, capabilityId }, "pairing code request failed");
                    });
            }
            if (update.connection === "open") {
                phase = "ready";
                pairing = undefined;
                ladder.reset();
                const me = socket.user;
                selfJid = me?.id === undefined ? undefined : jidNormalizedUser(me.id);
                selfLid = me?.lid === undefined || me.lid === "" ? undefined : jidNormalizedUser(me.lid);
                log.info({ capabilityId, selfJid }, "whatsapp connected");
                return;
            }
            if (update.connection === "close") {
                if (closed) {
                    return;
                }
                const reason = ((update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode ??
                    0) as number;
                if (reason === (DisconnectReason.loggedOut as number)) {
                    // Phone unlinked or number gone; wipe the dead session so the next reconcile starts a fresh
                    // pairing.
                    closed = true;
                    connections.delete(capabilityId);
                    closers.delete(capabilityId);
                    void rm(sessionDir, { recursive: true, force: true }).finally(() =>
                        options.onLoggedOut("WhatsApp unlinked this device: a fresh pairing code will appear on the capability card"),
                    );
                    return;
                }
                // restartRequired (515) is normal right after pairing succeeds; reconnect immediately.
                const rung = ladder.next();
                const wait = reason === (DisconnectReason.restartRequired as number) ? 0 : rung;
                phase = auth.state.creds.registered ? "connecting" : "pairing";
                // A code dies with the socket that minted it; clear it rather than leave a dead code reading as live.
                if (phase === "pairing" && pairing?.state === "code") {
                    pairing = { state: "waiting" };
                }
                setTimeout(start, wait);
            }
        });
        socket.ev.on("messages.upsert", ({ messages, type }) => {
            // Only `notify` is live traffic; other types are history backfill and must not trigger anything.
            if (type !== "notify") {
                return;
            }
            for (const message of messages as unknown as WaRawMessage[]) {
                const chat = message.key.remoteJid;
                if (chat === undefined || chat === null || chat === "status@broadcast") {
                    continue;
                }
                remember(message);
                if (message.key.fromMe !== true) {
                    seenChats.set(chat, {
                        name: message.pushName ?? chat.split("@")[0] ?? chat,
                        kind: chat.endsWith("@g.us") ? "group" : "dm",
                    });
                }
                options.onMessage(message);
            }
        });
    };

    const connection: WhatsAppConnection = {
        capabilityId,
        selfJid: () => selfJid,
        selfLid: () => selfLid,
        phase: () => phase,
        pairing: () => pairing,
        sendText: async (chat, text, quotedId) => {
            const quoted = quotedId === undefined ? undefined : rawCache.get(quotedId);
            await live().sendMessage(chat, { text }, quoted === undefined ? undefined : { quoted: quoted as never });
        },
        sendFile: async (chat, path) => {
            const buffer = await readFile(path);
            const name = basename(path);
            if (IMAGE_EXTENSIONS.has(extname(path).toLowerCase())) {
                await live().sendMessage(chat, { image: buffer, caption: name });
                return;
            }
            await live().sendMessage(chat, { document: buffer, fileName: name, mimetype: "application/octet-stream" });
        },
        presence: async (chat, state) => {
            await live().sendPresenceUpdate(state, chat);
        },
        listChats: async () => {
            // Groups come from the API; DMs come only from what this session has observed.
            const groups = await live()
                .groupFetchAllParticipating()
                .catch(() => ({}) as Record<string, { subject?: string }>);
            const entries = new Map<string, ChatEntry>();
            for (const [jid, meta] of Object.entries(groups)) {
                entries.set(jid, { jid, name: meta.subject ?? jid, kind: "group" });
            }
            for (const [jid, seen] of seenChats) {
                if (!entries.has(jid)) {
                    entries.set(jid, { jid, name: seen.name, kind: seen.kind });
                }
            }
            return [...entries.values()];
        },
        download: async (id, destDir) => {
            const raw = rawCache.get(id);
            if (raw === undefined) {
                return undefined;
            }
            const media = mediaSlotOf(raw);
            if (media === undefined) {
                return undefined;
            }
            const buffer = (await downloadMediaMessage(raw as never, "buffer", {})) as Buffer;
            await mkdir(destDir, { recursive: true });
            const path = join(destDir, `${id}-${media.name}`);
            await writeFile(path, buffer);
            return path;
        },
    };

    connections.set(capabilityId, connection);
    closers.set(capabilityId, {
        close: () => {
            closed = true;
            // end() drops the socket without touching the session; logout is reserved for forget().
            sock?.end(undefined);
        },
        logout: async () => {
            if (sock !== undefined && phase === "ready") {
                await sock.logout();
            }
        },
    });
    start();
    return connection;
};

// Filename a raw message's media should be saved as; documentMessage keeps its own name, others use kind plus mimetype
// extension.
const mediaSlotOf = (raw: WaRawMessage): { name: string } | undefined => {
    const content = raw.message ?? undefined;
    const inner =
        content?.ephemeralMessage?.message ??
        content?.viewOnceMessage?.message ??
        content?.viewOnceMessageV2?.message ??
        content?.documentWithCaptionMessage?.message ??
        content;
    if (inner === undefined) {
        return undefined;
    }
    if (inner.documentMessage !== undefined) {
        return { name: inner.documentMessage.fileName ?? `document.${extensionOf(inner.documentMessage.mimetype)}` };
    }
    if (inner.imageMessage !== undefined) {
        return { name: `photo.${extensionOf(inner.imageMessage.mimetype)}` };
    }
    if (inner.audioMessage !== undefined) {
        return { name: `voice.${extensionOf(inner.audioMessage.mimetype)}` };
    }
    if (inner.videoMessage !== undefined) {
        return { name: `video.${extensionOf(inner.videoMessage.mimetype)}` };
    }
    if (inner.stickerMessage !== undefined) {
        return { name: `sticker.${extensionOf(inner.stickerMessage.mimetype)}` };
    }
    return undefined;
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
