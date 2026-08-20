import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import makeWASocket, { DisconnectReason, downloadMediaMessage, jidNormalizedUser, useMultiFileAuthState } from "baileys";
import type { ListenerPairing } from "@intentic/sandbox-contract";
import type { Logger } from "@intentic/connector-runtime";
import type { WaRawMessage } from "./types.js";

/* The gateway's WhatsApp connections, one multi-device socket per configured capability, paired as a linked
 * device and alive only while the daemon says an enabled whatsapp listener automation (or the CLI's connector)
 * exists. A module singleton map, like the other gateway extensions': the reconcile loop, the listener and the
 * control surface all reach it directly.
 *
 * THIS IS THE ONLY FILE THAT IMPORTS BAILEYS. Everything else in the package works on the structural types in
 * types.ts, which keeps the listener and painter testable while baileys is not yet installed, and keeps the
 * scope of a baileys major bump to one file.
 *
 * The credential here is not a token, it is the SESSION the pairing ceremony mints, persisted as baileys'
 * multi-file auth state under the session dir. That is why open() has two personalities: with a REGISTERED
 * session it resumes silently; otherwise it requests a PAIRING CODE for the configured phone number and
 * surfaces it (the gateway posts it in status, the capability card shows it), then sits in "pairing" until the
 * phone enters it. WhatsApp closes an unpaired socket after a while, so the recreate loop mints a fresh code
 * when that happens, the card always shows the current one, stamped with when it was minted.
 *
 * EVERY MOMENT OF THAT CEREMONY IS REPORTED, not just the ones holding a code. `pairing()` answers `waiting`
 * before the first code and again the instant a socket dies with one, `code` while one is live, and `failed`
 * with WhatsApp's own complaint when the number is refused. Publishing only codes is what let a phone that had
 * never linked read as connected: the daemon saw an absent code during the two seconds before the first one
 * arrived, decided nothing was outstanding, and the card went green, so the owner was navigated away from the
 * only screen that was ever going to show them the code. */

// Reconnect backoff for ordinary closes (network blips, server restarts). Pairing-phase closes reuse it too,
// each recreate mints a fresh code, and hammering the pairing endpoint reads as abuse.
const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 60_000;
// How many raw messages we keep for media download / reply-quoting. WhatsApp media is end-to-end encrypted and
// can only be fetched with the original message envelope, so a download reaches back at most this far.
const RAW_CACHE_MAX = 500;

export type ConnectionPhase = "pairing" | "connecting" | "ready";

export interface ChatEntry {
    readonly jid: string;
    readonly name: string;
    readonly kind: "group" | "dm";
}

export interface WhatsAppConnection {
    readonly capabilityId: string;
    // Our own identities, set once the socket opens: the phone JID always, the @lid (hidden-number) identity
    // when WhatsApp assigns one. Mentions in groups may use either, so mention detection needs both.
    readonly selfJid: () => string | undefined;
    readonly selfLid: () => string | undefined;
    readonly phase: () => ConnectionPhase;
    // Where the link-a-device ceremony stands, or undefined once this session is paired.
    readonly pairing: () => ListenerPairing | undefined;
    readonly sendText: (chat: string, text: string, quotedId?: string) => Promise<void>;
    readonly sendFile: (chat: string, path: string) => Promise<void>;
    readonly presence: (chat: string, state: "composing" | "paused") => Promise<void>;
    readonly listChats: () => Promise<ChatEntry[]>;
    // Fetch and decrypt a cached message's media into destDir; the written path, or undefined when the id is
    // unknown (aged out of the cache) or the message carries no media.
    readonly download: (id: string, destDir: string) => Promise<string | undefined>;
}

const connections = new Map<string, WhatsAppConnection>();
// close: drop the socket, keep the session. logout: tell the phone to drop us from Linked devices (needs the
// live socket, so it lives here beside close rather than on the public connection surface).
const closers = new Map<string, { close: () => void; logout: () => Promise<void> }>();

export const whatsappConnection = (capabilityId: string): WhatsAppConnection | undefined => connections.get(capabilityId);
export const whatsappConnections = (): ReadonlyMap<string, WhatsAppConnection> => connections;

export interface OpenOptions {
    readonly capabilityId: string;
    readonly phoneNumber: string;
    readonly sessionDir: string;
    readonly log: Logger;
    readonly onMessage: (message: WaRawMessage) => void;
    // The session ended for good (the phone unlinked us, or the number was banned): the session dir is already
    // wiped and the connection gone from the pool, the next reconcile starts a fresh pairing.
    readonly onLoggedOut: (detail: string) => void;
}

// Baileys wants digits only ("4915112345678"), people write numbers with +, spaces and dashes.
const digitsOf = (phoneNumber: string): string => phoneNumber.replaceAll(/\D/g, "");

// A no-op pino-shaped logger: baileys' default logs its internals to stdout, and a protocol trace is noise the
// tmux capture doesn't need. Structural, cast at the boundary, pulling pino in for silence would be absurd.
const silentLogger = {
    level: "silent",
    child: (): object => silentLogger,
    trace: (): void => undefined,
    debug: (): void => undefined,
    info: (): void => undefined,
    warn: (): void => undefined,
    error: (): void => undefined,
};

// The extension a downloaded medium gets, from its declared mimetype ("audio/ogg; codecs=opus" → .ogg).
const extensionOf = (mimetype: string | undefined): string => {
    const subtype = mimetype?.split("/")[1]?.split(";")[0]?.trim();
    return subtype === undefined || subtype === "" ? "bin" : subtype.replace("jpeg", "jpg");
};

// What sendFile should send a path as: images ride as pictures (they preview in the chat), everything else as
// a document with its filename intact.
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

// Whether a session dir holds a session worth resuming. Anything else there is the WRECKAGE OF AN UNFINISHED
// CEREMONY, half-written noise keys and an ephemeral pairing key belonging to a code that died with the socket
// that minted it, and resuming that instead of starting clean is how a re-add inherits a stranger's dead
// handshake. A missing or unreadable file reads as "nothing to resume", which is exactly the safe answer.
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
    // Start every ceremony from nothing: a stored session is kept only once the phone actually completed it.
    if (!(await sessionRegistered(sessionDir))) {
        await rm(sessionDir, { recursive: true, force: true });
    }
    await mkdir(sessionDir, { recursive: true });
    const auth = await useMultiFileAuthState(sessionDir);

    // The live socket the closures below act through, replaced by every recreate, so nothing may capture it.
    let sock: ReturnType<typeof makeWASocket> | undefined;
    let phase: ConnectionPhase = "connecting";
    // Undefined only once the phone has linked; every other moment of the ceremony is one of the three states.
    let pairing: ListenerPairing | undefined = auth.state.creds.registered ? undefined : { state: "waiting" };
    let selfJid: string | undefined;
    let selfLid: string | undefined;
    let closed = false;
    let backoff = RETRY_MIN_MS;

    // Recent raw messages by id (download needs the envelope to decrypt; replies quote it), and the chats this
    // session has seen (WhatsApp has no on-demand chat list, groups come from the API, DMs from traffic).
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
            throw new Error("WhatsApp is not connected — pair the device from the capability card first");
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
            // Linked devices are listed by this name on the phone; "intentic" says which device to unlink.
            browser: ["intentic", "Chrome", "1.0"],
            markOnlineOnConnect: false,
            syncFullHistory: false,
        });
        sock = socket;
        phase = auth.state.creds.registered ? "connecting" : "pairing";
        // A fresh socket means a fresh code is coming, unless the last attempt was REFUSED, whose sentence is
        // the one thing on the card worth acting on and must not be flickered away by every retry behind it.
        if (phase === "pairing" && pairing?.state !== "failed") {
            pairing = { state: "waiting" };
        }
        let pairingRequested = false;

        socket.ev.on("creds.update", () => void auth.saveCreds());
        socket.ev.on("connection.update", (update) => {
            // The qr field arriving is the socket saying "ready to pair", the cue to ask for a phone-number
            // pairing code instead (we never render the QR; a code types into a phone, a QR needs a screen dance).
            if (update.qr !== undefined && !auth.state.creds.registered && !pairingRequested) {
                pairingRequested = true;
                void socket
                    .requestPairingCode(phone)
                    .then((code) => {
                        pairing = { state: "code", code, since: Date.now() };
                        log.info({ capabilityId }, "pairing code issued");
                    })
                    .catch((error: unknown) => {
                        // WhatsApp refusing the number (not a WhatsApp account, malformed, asked too often) is
                        // the owner's problem to fix, and a warning in a log nobody opens is not telling them.
                        pairing = { state: "failed", detail: error instanceof Error ? error.message : String(error) };
                        log.warn({ err: error, capabilityId }, "pairing code request failed");
                    });
            }
            if (update.connection === "open") {
                phase = "ready";
                pairing = undefined;
                backoff = RETRY_MIN_MS;
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
                    // The phone unlinked us (or the number is gone). The session is dead evidence, wipe it so
                    // the next reconcile starts a fresh pairing rather than resuming a corpse.
                    closed = true;
                    connections.delete(capabilityId);
                    closers.delete(capabilityId);
                    void rm(sessionDir, { recursive: true, force: true }).finally(() =>
                        options.onLoggedOut("WhatsApp unlinked this device — a fresh pairing code will appear on the capability card"),
                    );
                    return;
                }
                // restartRequired (515) is the NORMAL close right after pairing succeeds, reconnect at once.
                const wait = reason === (DisconnectReason.restartRequired as number) ? 0 : backoff;
                backoff = Math.min(backoff * 2, RETRY_MAX_MS);
                phase = auth.state.creds.registered ? "connecting" : "pairing";
                // A CODE DIES WITH THE SOCKET THAT MINTED IT, and the next one is up to a minute of backoff
                // away. Left on the card it is worse than nothing: it reads as the live code, and the owner
                // spends their attempt, and the walk through the phone's menus, typing something already dead.
                if (phase === "pairing" && pairing?.state === "code") {
                    pairing = { state: "waiting" };
                }
                setTimeout(start, wait);
            }
        });
        socket.ev.on("messages.upsert", ({ messages, type }) => {
            // "notify" is live traffic; everything else is history backfill, which must not wake agents.
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
            // Groups from the API (complete), DMs from what this session has seen (all WhatsApp offers).
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
            // end() drops the socket without touching the session; logout is only for forget().
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

// What a raw message's media should be saved as. documentMessage keeps its own filename; the rest get named by
// kind + mimetype extension.
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

// Drop the socket, keep the session, a reconcile close (automations gone, gateway shutdown). The next open
// resumes without re-pairing.
export const closeWhatsAppConnection = (capabilityId: string): void => {
    connections.delete(capabilityId);
    closers.get(capabilityId)?.close();
    closers.delete(capabilityId);
};

// Unlink and forget, the connector was REMOVED. Logout tells the phone to drop us from Linked devices; the
// session dir wipe makes a future re-add start a fresh pairing instead of resuming a stranger's session.
export const forgetWhatsAppConnection = async (capabilityId: string, sessionDir: string, log: Logger): Promise<void> => {
    const closer = closers.get(capabilityId);
    connections.delete(capabilityId);
    closers.delete(capabilityId);
    // Best-effort: reaching the phone needs the socket that is about to die anyway.
    await closer?.logout().catch((error: unknown) => log.warn({ err: error }, "whatsapp logout failed"));
    closer?.close();
    await rm(sessionDir, { recursive: true, force: true });
};
