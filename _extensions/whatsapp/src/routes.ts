import type { IncomingMessage } from "node:http";
import { errorMessage } from "@intentic/base/errors";
import type { Logger } from "@intentic/connector-runtime";
import { z } from "zod";
import type { HistoryFetch, WhatsAppConnection } from "./client.js";
import { jidUser } from "./content.js";
import type { DirectoryEntry, MessageRow } from "./store.js";
import type { ChatTarget } from "./sync.js";

// The loopback control surface the `whatsapp` CLI drives. Every answer is the human-readable text the CLI prints for
// the model, so a refusal says what to do next: an ambiguous name lists the people it could mean, an unknown one
// points at `whatsapp contacts`.

export interface RouteDeps {
    // The connection the CLI acts through; with several paired numbers, whichever connected first.
    readonly ready: () => WhatsAppConnection | undefined;
    readonly connections: () => ReadonlyMap<string, WhatsAppConnection>;
    readonly mediaDir: string;
    readonly log: Logger;
}

export type RouteAnswer = { readonly status?: number; readonly body: string } | undefined;

const NOT_CONNECTED = { status: 503, body: "WhatsApp is not connected, pair the device from the capability card first." };
const HISTORY_DEFAULT = 30;
const HISTORY_MAX = 200;

const phoneOf = (entry: DirectoryEntry): string | undefined => (entry.phone === undefined ? undefined : `+${jidUser(entry.phone)}`);

// The name a person or group goes by here: the owner's saved name first, then the chat's title, then their own.
export const labelOf = (entry: DirectoryEntry): string =>
    entry.name ?? entry.chatName ?? entry.notify ?? entry.verified ?? entry.username ?? phoneOf(entry) ?? entry.jid;

// One line per person: where to send, number, saved name, and what they call themselves when that differs.
export const contactLine = (entry: DirectoryEntry): string => {
    const own = entry.notify !== undefined && entry.notify !== labelOf(entry) ? `\t~${entry.notify}` : "";
    return `${entry.jid}\t${entry.kind}\t${labelOf(entry)}\t${phoneOf(entry) ?? "-"}${own}`;
};

const candidatesBody = (query: string, candidates: readonly DirectoryEntry[]): string =>
    [`"${query}" could mean any of these; send to one by its JID:`, ...candidates.map(contactLine)].join("\n");

// A chat target the CLI named, or the answer explaining why there is none.
const settle = (query: string, target: ChatTarget): { jid: string; label: string } | { status: number; body: string } => {
    if (target.kind === "jid") {
        return { jid: target.jid, label: target.label === undefined ? target.jid : `${target.label} (${target.jid})` };
    }
    if (target.kind === "ambiguous") {
        return { status: 409, body: candidatesBody(query, target.candidates) };
    }
    return {
        status: 404,
        body: `No contact, group or chat matches "${query}". \`whatsapp contacts <part of a name>\` lists who this number knows; a phone number with its country code always works.`,
    };
};

const FETCH_NOTES = {
    stored: "",
    answered: "",
    timeout: "(The phone did not answer a request for older messages within 20s: it may be offline. This is what the gateway holds.)",
    "no-anchor": "(Nothing from this chat is stored yet, so there is no message to ask the phone for older ones from.)",
} as const satisfies Record<HistoryFetch, string>;

const historyLine = (row: MessageRow, nameOf: (jid: string) => string | undefined): string => {
    const when = new Date(row.ts * 1_000).toISOString().slice(0, 16).replace("T", " ");
    const who = row.fromMe ? "you" : ((row.author === undefined ? undefined : nameOf(row.author)) ?? row.authorName ?? jidUser(row.author));
    return `${when}  ${who}: ${row.text}  [${row.id}]`;
};

// What a CLI request body may carry; blank strings count as absent, and anything else in the body is ignored.
const word = z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim() === "" ? undefined : value));
const RequestSchema = z.object({
    chat: word,
    text: word,
    reply: word,
    path: word,
    id: word,
    // "" is a real emoji value: it removes our reaction.
    emoji: z.string().optional(),
    voice: z.boolean().optional(),
});
type ControlRequest = z.infer<typeof RequestSchema>;

const parse = async (body: () => Promise<string>): Promise<ControlRequest> => RequestSchema.parse(JSON.parse((await body()) || "{}"));

// One request the CLI made, on a connected device: the URL for query strings, the parsed body on demand.
interface Ask {
    readonly connection: WhatsAppConnection;
    readonly url: URL;
    readonly request: () => Promise<ControlRequest>;
    readonly log: Logger;
}
type Answer = NonNullable<RouteAnswer>;

const listChats = async ({ connection, url, log }: Ask): Promise<Answer> => {
    let chats: DirectoryEntry[];
    try {
        chats = await connection.listChats();
    } catch (error) {
        log.warn({ err: error }, "whatsapp chat listing failed");
        return { status: 502, body: `WhatsApp would not list this number's groups: ${errorMessage(error)}` };
    }
    const query = url.searchParams.get("q") ?? "";
    if (query === "") {
        return { body: chats.length === 0 ? "No chats known yet." : chats.map(contactLine).join("\n") };
    }
    const shown = connection.searchContacts(query);
    return { body: shown.length === 0 ? `Nothing matches "${query}".` : shown.map(contactLine).join("\n") };
};

const listContacts = async ({ connection, url }: Ask): Promise<Answer> => {
    const query = url.searchParams.get("q") ?? "";
    if (query.trim() === "") {
        return { status: 400, body: "Give part of a name or number: `whatsapp contacts <query>`." };
    }
    const found = connection.searchContacts(query);
    return { body: found.length === 0 ? `Nobody matches "${query}".` : found.slice(0, 50).map(contactLine).join("\n") };
};

const readHistory = async ({ connection, url }: Ask): Promise<Answer> => {
    const query = url.searchParams.get("chat") ?? "";
    const target = settle(query, await connection.resolveChat(query));
    if ("status" in target) {
        return target;
    }
    const limit = Math.min(HISTORY_MAX, Math.max(1, Number(url.searchParams.get("limit")) || HISTORY_DEFAULT));
    const { messages, fetch } = await connection.history(target.jid, limit);
    const note: string = FETCH_NOTES[fetch];
    const lines = [`${target.label}, last ${messages.length} message(s), oldest first:`, ...messages.map((row) => historyLine(row, connection.nameOf))];
    return { body: (note === "" ? lines : [...lines, note]).join("\n") };
};

// The commands that act on one chat: the chat is resolved first, and an ambiguous or unknown one answers instead.
const toChat =
    (act: (connection: WhatsAppConnection, target: { jid: string; label: string }, request: ControlRequest) => Promise<Answer>) =>
    async ({ connection, request }: Ask): Promise<Answer> => {
        const fields = await request();
        if (fields.chat === undefined) {
            return { status: 400, body: "chat required" };
        }
        const target = settle(fields.chat, await connection.resolveChat(fields.chat));
        return "status" in target ? target : act(connection, target, fields);
    };

const send = toChat(async (connection, target, { text, reply }) => {
    if (text === undefined) {
        return { status: 400, body: "chat and text required" };
    }
    await connection.sendText(target.jid, text, reply);
    return { body: `Sent to ${target.label}.` };
});

const sendFile = toChat(async (connection, target, { path, voice }) => {
    if (path === undefined) {
        return { status: 400, body: "chat and path required" };
    }
    if (voice === true) {
        await connection.sendVoice(target.jid, path);
        return { body: `Sent ${path} to ${target.label} as a voice note.` };
    }
    await connection.sendFile(target.jid, path);
    return { body: `Sent ${path} to ${target.label}.` };
});

const react = toChat(async (connection, target, { id, emoji }) => {
    if (id === undefined || emoji === undefined) {
        return { status: 400, body: "chat, id and emoji required" };
    }
    await connection.react(target.jid, id, emoji);
    return { body: emoji === "" ? `Removed the reaction on ${id}.` : `Reacted ${emoji} to ${id} in ${target.label}.` };
});

const CONNECTED_ROUTES = new Map<string, (ask: Ask) => Promise<Answer>>([
    ["GET /chats", listChats],
    ["GET /contacts", listContacts],
    ["GET /history", readHistory],
    ["POST /send", send],
    ["POST /send-file", sendFile],
    ["POST /react", react],
]);

// Media lives with whichever paired number received it, so a download asks every connection, connected or not.
const download = async (deps: RouteDeps, { id }: ControlRequest): Promise<Answer> => {
    if (id === undefined) {
        return { status: 400, body: "id required" };
    }
    for (const connection of deps.connections().values()) {
        const written = await connection.download(id, deps.mediaDir);
        if (written !== undefined) {
            return { body: written };
        }
    }
    return { status: 404, body: "No downloadable media under that id: it is not a stored message, or it carries no file." };
};

export const createControlRoutes =
    (deps: RouteDeps) =>
    async (req: Pick<IncomingMessage, "method" | "url">, body: () => Promise<string>): Promise<RouteAnswer> => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const route = `${req.method ?? "GET"} ${url.pathname}`;
        if (route === "POST /download") {
            return download(deps, await parse(body));
        }
        const handle = CONNECTED_ROUTES.get(route);
        if (handle === undefined) {
            return undefined;
        }
        const connection = deps.ready();
        return connection === undefined ? NOT_CONNECTED : handle({ connection, url, request: () => parse(body), log: deps.log });
    };
