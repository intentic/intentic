import { randomBytes } from "node:crypto";
import { WEBEXT_CHATGPT_SEND_TOOL, WEBEXT_FILE_TICKET_TTL_MS, WEBEXT_UPLOAD_TOOL } from "@intentic/sandbox-contract/protocol/doors/webext-links";
import { z } from "zod";
import type { RpcMessage } from "../agent/tools/turn-mounts.js";
import type { PeerCallRoute } from "../peers/peer-routes.js";
import { releasable, type ShelfFile } from "./media-shelf.js";

// A sandbox file put into a page in the owner's own browser (`upload_file`, and `chatgpt_send`'s `files`, one ticket
// each into its `tickets` in the same order), released only for a call an agent's turn
// actually made. The extension never asks for a file by path: the daemon sees the agent's call on its way to the
// browser, checks the path is a file on the artifacts shelf (media-shelf.ts), and adds a one-time ticket to the call's
// arguments; the extension presents that ticket at its own door (POST /system/webext/file, on its enrollment token) and
// the bytes come back on that answer. So a leaked extension token reads no file at all, and an agent cannot name a file
// off the shelf. What the person sees before anything reaches the site (its name and size, asked on the page) is the
// extension's half. Tickets live in this process's memory alone: a restart forgets them and the call fails.

interface Ticket {
    readonly card: string;
    // As the agent asked for it, checked again when it is collected, so a link swapped in between finds a refusal.
    readonly asked: string;
    readonly root: string;
    readonly expiresAt: number;
}

export type FileRedemption = ({ readonly ok: true } & ShelfFile) | { readonly ok: false; readonly status: 403 | 404 | 410; readonly refusal: string };

export interface FileTicketDesk {
    // The agent's call, with a ticket in its arguments when it is an `upload_file` (or a `chatgpt_send` with files) naming
    // files that may go; a refusal the agent reads when it names one that may not; undefined for every other message,
    // which goes on as it came.
    readonly route: (card: string, message: RpcMessage, root: string) => Promise<PeerCallRoute | undefined>;
    readonly redeem: (card: string, ticket: string) => Promise<FileRedemption>;
}

// 256 bits, as a secret ticket's: a ticket is a bearer for one file for a minute.
const TICKET_BYTES = 32;

const UploadArgsSchema = z.looseObject({ path: z.string().min(1) });
const SendArgsSchema = z.looseObject({ files: z.array(z.string().min(1)).min(1) });
const CalledSchema = z.looseObject({ name: z.enum([WEBEXT_UPLOAD_TOOL, WEBEXT_CHATGPT_SEND_TOOL]), arguments: z.unknown() });

type Called = z.infer<typeof CalledSchema>;

// The sandbox paths a call names (upload_file's one, chatgpt_send's several) and its arguments with minted tickets put
// where its tool reads them; undefined when it names none.
interface Ticketable {
    readonly paths: readonly string[];
    readonly withTickets: (minted: readonly string[]) => object;
}

const ticketable = (called: Called): Ticketable | undefined => {
    if (called.name === WEBEXT_UPLOAD_TOOL) {
        const upload = UploadArgsSchema.safeParse(called.arguments);
        return upload.success ? { paths: [upload.data.path], withTickets: (minted) => ({ ...upload.data, ticket: minted[0] }) } : undefined;
    }
    const send = SendArgsSchema.safeParse(called.arguments);
    return send.success ? { paths: send.data.files, withTickets: (minted) => ({ ...send.data, tickets: minted }) } : undefined;
};

// The tools whose calls carry files, for the peer route to hand here.
export const TICKETED_TOOLS: ReadonlySet<string> = new Set([WEBEXT_UPLOAD_TOOL, WEBEXT_CHATGPT_SEND_TOOL]);

export const createFileTickets = ({ now = Date.now }: { readonly now?: () => number } = {}): FileTicketDesk => {
    const tickets = new Map<string, Ticket>();
    // Expired tickets are dropped as new ones are made, so a turn that never collected leaves nothing behind for long.
    const sweep = (): void => {
        for (const [ticket, entry] of tickets) {
            if (now() > entry.expiresAt) {
                tickets.delete(ticket);
            }
        }
    };
    return {
        route: async (card, message, root) => {
            const called = message.method === "tools/call" ? CalledSchema.safeParse(message.params) : undefined;
            const found = called?.success === true ? ticketable(called.data) : undefined;
            if (called?.success !== true || found === undefined) {
                // Another message, or one the browser's own schema refuses, or a send with no file to ticket.
                return undefined;
            }
            for (const path of found.paths) {
                const file = await releasable(root, path);
                if (!file.ok) {
                    return { refusal: file.refusal };
                }
            }
            sweep();
            const minted = found.paths.map((path) => {
                const ticket = randomBytes(TICKET_BYTES).toString("base64url");
                tickets.set(ticket, { card, asked: path, root, expiresAt: now() + WEBEXT_FILE_TICKET_TTL_MS });
                return ticket;
            });
            // Whatever the agent put in `ticket` or `tickets` is replaced: only ones this daemon minted open the door.
            return { id: card, message: { ...message, params: { ...called.data, arguments: found.withTickets(minted) } } };
        },
        redeem: async (card, ticket) => {
            const entry = tickets.get(ticket);
            // One ticket, one collection, whatever comes of it.
            tickets.delete(ticket);
            if (entry === undefined) {
                return { ok: false, status: 404, refusal: "That ticket is not one this sandbox issued, or it was already used." };
            }
            if (entry.card !== card) {
                return { ok: false, status: 403, refusal: "That ticket was issued to another browser." };
            }
            if (now() > entry.expiresAt) {
                return { ok: false, status: 410, refusal: `That ticket expired: a browser has ${WEBEXT_FILE_TICKET_TTL_MS / 1000} s to collect a file after it is asked to upload it.` };
            }
            const file = await releasable(entry.root, entry.asked);
            return file.ok ? file : { ok: false, status: 403, refusal: file.refusal };
        },
    };
};
