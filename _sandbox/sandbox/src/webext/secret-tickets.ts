import { createHash, randomBytes } from "node:crypto";
import { errorMessage } from "@intentic/base/errors";
import { WEBEXT_TICKET_TOOL, WEBEXT_TICKET_TTL_MS } from "@intentic/sandbox-contract/protocol/doors/webext-links";
import type { WebExtSecretRequest } from "@intentic/sandbox-contract/schemas/webext";
import { z } from "zod";
import { callFailure } from "../peers/call-failure.js";
import type { WebExtHub } from "./webext-peer.js";

// A stored secret typed into the focused field of the owner's OWN browser, with the agent never holding the value. The
// value cannot ride the socket: whatever a browser's tool answers is something a model may read. So the daemon calls
// the browser's `type_ticket` tool with a one-time ticket and nothing else; the extension reads the field it is about to
// type into, presents the ticket at its own door (POST /system/webext/secret, on its enrollment token) with that page,
// and only there does the value cross, on the HTTP answer, after the caller's own guard has judged the page. Tickets live
// in this process's memory and nowhere else: a restart forgets them, and an in-flight typing fails rather than replays.

export interface TicketPage {
    readonly url: string;
    readonly host: string;
    readonly field: "password" | "text";
}
export type TicketAnswer = { readonly value: string } | { readonly refusal: string };
export interface OwnerBrowserTypeArgs {
    // The webext capability id the turn has mounted (e.g. "chrome").
    readonly card: string;
    // The secret's name, for words and logs only.
    readonly secret: string;
    // Run at most once, when the extension redeems the ticket, with the page the extension is about to type into. It runs
    // the host guard and approval cards (may wait minutes on a person) and answers the value or a refusal sentence.
    readonly redeem: (page: TicketPage, signal: AbortSignal) => Promise<TicketAnswer>;
    readonly signal?: AbortSignal;
}
export type OwnerBrowserTyped =
    | { readonly ok: true; readonly host: string; readonly field: "password" | "text" }
    | { readonly ok: false; readonly refusal: string };
export interface SecretTickets {
    readonly typeIn: (args: OwnerBrowserTypeArgs) => Promise<OwnerBrowserTyped>;
}

// What the door makes of one presented ticket: the value, or a refusal with the status that says whose doing it was.
// `secret` names what was asked for, for the door's log line, whenever the ticket was one this daemon minted.
export type TicketRedemption =
    | { readonly ok: true; readonly value: string; readonly secret: string; readonly page: TicketPage }
    | { readonly ok: false; readonly status: 400 | 403 | 404 | 409 | 410 | 500; readonly refusal: string; readonly secret?: string };

// The service as the daemon holds it: the turn's half (`typeIn`) and the door's half (`redeem`), over one ticket table.
export interface SecretTicketDesk extends SecretTickets {
    readonly redeem: (card: string, request: WebExtSecretRequest, signal: AbortSignal) => Promise<TicketRedemption>;
}

export interface SecretTicketDeps {
    readonly hub: Pick<WebExtHub, "online" | "offline" | "knownTools" | "mcp">;
    // How long the whole call may take once the browser has the ticket, approval cards included.
    readonly callTimeoutMs: number;
    readonly now?: () => number;
}

interface Ticket {
    readonly card: string;
    readonly secret: string;
    readonly redeem: OwnerBrowserTypeArgs["redeem"];
    readonly expiresAt: number;
    // Aborted the moment `typeIn` stops waiting, so a redemption still at an approval card stops with it, and one that
    // finished after the turn gave up hands nothing over.
    readonly done: AbortController;
    // Set by the first presentation, whatever came of it: one ticket, one chance.
    spent: boolean;
    // The page the value was released for; only set once it was, and the only account of where it went that this
    // daemon trusts, rather than the browser's own report.
    released?: TicketPage;
}

// 256 bits: a ticket is a bearer for one secret for a minute, and nothing about a guess should be cheaper than the token
// the door already asks for.
const TICKET_BYTES = 32;

// What a browser last listed, read for one name; anything else it says is its own business.
const ListedToolsSchema = z.object({ tools: z.array(z.looseObject({ name: z.string() })) });

// The browser's answer to `type_ticket`, as far as this reads it: whether it typed, and its sentence when it did not.
const TicketCallAnswerSchema = z.object({
    result: z.looseObject({ isError: z.boolean().optional(), content: z.array(z.looseObject({ text: z.string().optional() })).optional() }).optional(),
    error: z.looseObject({ message: z.string() }).optional(),
});
type TicketCallAnswer = z.infer<typeof TicketCallAnswerSchema>;

// Read through a call rather than off the signal directly: the caller's signal is checked before the call and again
// after it threw, and the compiler would otherwise carry the first answer across the await.
const cancelled = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

// A short, stable name for a ticket in a log line: enough to match two lines about the same one, and nothing a reader
// could present at the door in its place.
export const ticketTag = (ticket: string): string => createHash("sha256").update(ticket).digest("hex").slice(0, 8);

const hostOf = (url: string): string | undefined => {
    try {
        const parsed = new URL(url);
        return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.host : undefined;
        // allow(silent-catch): a URL that does not parse is refused by the caller as no page at all
    } catch {
        return undefined;
    }
};

export const createSecretTickets = ({ hub, callTimeoutMs, now = Date.now }: SecretTicketDeps): SecretTicketDesk => {
    const tickets = new Map<string, Ticket>();

    // The browser's own sentence when it refused, or what this daemon knows was typed when it did not.
    const outcome = (card: string, entry: Ticket, { result, error }: TicketCallAnswer): OwnerBrowserTyped => {
        if (error !== undefined) {
            return { ok: false, refusal: error.message };
        }
        const said = result?.content?.map((block) => block.text ?? "").join("\n").trim() ?? "";
        if (result?.isError === true) {
            return { ok: false, refusal: said === "" ? `"${card}" refused to type the secret, without saying why.` : said };
        }
        // Where the value went is this daemon's record of the page it released it for, never the browser's word.
        if (entry.released === undefined) {
            return { ok: false, refusal: `"${card}" said it typed the secret, but it never collected it from this sandbox, so nothing was typed.` };
        }
        return { ok: true, host: entry.released.host, field: entry.released.field };
    };

    return {
        typeIn: async ({ card, secret, redeem, signal }) => {
            if (!hub.online(card)) {
                return { ok: false, refusal: hub.offline(card) };
            }
            const listed = ListedToolsSchema.safeParse(hub.knownTools(card));
            if (!listed.success) {
                return { ok: false, refusal: `"${card}" has not said what it can do yet: it has only just connected. Try again in a moment.` };
            }
            if (!listed.data.tools.some((tool) => tool.name === WEBEXT_TICKET_TOOL)) {
                return {
                    ok: false,
                    refusal: `The Intentic extension in "${card}" is too old to type a stored secret. Ask the owner to update it (or reinstall it from the store), then try again.`,
                };
            }
            if (cancelled(signal)) {
                return { ok: false, refusal: "Stopped before the secret was typed." };
            }
            const ticket = randomBytes(TICKET_BYTES).toString("base64url");
            const entry: Ticket = { card, secret, redeem, expiresAt: now() + WEBEXT_TICKET_TTL_MS, done: new AbortController(), spent: false };
            tickets.set(ticket, entry);
            const deadline = AbortSignal.timeout(callTimeoutMs);
            try {
                const answer = TicketCallAnswerSchema.safeParse(
                    await hub.mcp(
                        card,
                        { jsonrpc: "2.0", id: `secret-${ticketTag(ticket)}`, method: "tools/call", params: { name: WEBEXT_TICKET_TOOL, arguments: { ticket } } },
                        { signal: signal === undefined ? deadline : AbortSignal.any([signal, deadline]) },
                    ),
                );
                return answer.success
                    ? outcome(card, entry, answer.data)
                    : { ok: false, refusal: `"${card}" answered in a way this sandbox cannot read, so nothing is known to have been typed.` };
            } catch (error) {
                if (cancelled(signal)) {
                    return { ok: false, refusal: "Stopped before the browser finished typing the secret." };
                }
                return { ok: false, refusal: callFailure("browser", card, "type_secret", error instanceof Error ? error : new Error(errorMessage(error)), callTimeoutMs).text };
            } finally {
                tickets.delete(ticket);
                entry.done.abort();
            }
        },
        redeem: async (card, request, signal) => {
            const entry = tickets.get(request.ticket);
            if (entry === undefined) {
                return { ok: false, status: 404, refusal: "That ticket is not one this sandbox is waiting on: it was never issued, or the call it was for has ended." };
            }
            const { secret } = entry;
            if (entry.spent) {
                return { ok: false, status: 409, refusal: "That ticket was already used: each one types a secret once.", secret };
            }
            // Spent before anything is awaited, so two presentations racing each other cannot both reach `redeem`.
            entry.spent = true;
            if (entry.card !== card) {
                // A ticket in the hands of a browser it was not minted for has leaked; it is burnt for its own browser too.
                return { ok: false, status: 403, refusal: "That ticket was issued to another browser.", secret };
            }
            if (now() > entry.expiresAt) {
                return { ok: false, status: 410, refusal: `That ticket expired: a browser has ${WEBEXT_TICKET_TTL_MS / 1000} s to collect a secret after it is asked to type it.`, secret };
            }
            const host = hostOf(request.url);
            if (host === undefined) {
                return { ok: false, status: 400, refusal: "That page is not an ordinary web page, so no secret is typed into it.", secret };
            }
            const page: TicketPage = { url: request.url, host, field: request.field };
            // Its error's own words are not passed on: whatever the guard threw over is no sentence for a browser, and
            // nothing here may risk carrying the value somewhere it is read.
            // allow(silent-catch): the error is dropped on purpose (above), and the browser is answered that nothing was released.
            const answer = await entry.redeem(page, AbortSignal.any([signal, entry.done.signal])).catch(() => undefined);
            if (answer === undefined) {
                return { ok: false, status: 500, refusal: "This sandbox could not release that secret just now, so nothing was typed. Try again.", secret };
            }
            if ("refusal" in answer) {
                return { ok: false, status: 403, refusal: answer.refusal, secret };
            }
            // The turn stopped waiting while the guard ran: nobody will report what happens next, so nothing happens.
            if (entry.done.signal.aborted || signal.aborted) {
                return { ok: false, status: 410, refusal: "The call this ticket was for has ended, so the secret was not handed over.", secret };
            }
            entry.released = page;
            return { ok: true, value: answer.value, secret, page };
        },
    };
};
