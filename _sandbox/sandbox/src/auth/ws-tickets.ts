import { randomBytes } from "node:crypto";
import type { VerifiedIdentity } from "./auth.js";

/* One-shot tickets for the WebSocket upgrades (/system/terminal, /system/browser-login, /system/browser-view).
 *
 * A browser cannot put an Authorization header on a WebSocket, so those three routes used to take the caller's
 * bearer as `?token=` — a 30-day session, or an hour-long Google ID token, written into a URL. URLs are the
 * least private part of a request: they reach Cloudflare's edge logs, the tunnel connector's logs, and any
 * proxy in between, none of which are places a credential that opens a root PTY should come to rest.
 *
 * So the credential stays on the HTTP side, where headers work: the browser POSTs /system/ws-ticket through the
 * ordinary bearer middleware, and gets back a ticket that is worth exactly one upgrade, for seconds, and
 * carries no identity a reader could extract. A ticket in a log is a spent ticket.
 *
 * In memory, deliberately. These are single-use and shorter-lived than a page load, so persisting them would
 * add a durable store of live credentials to protect — the opposite of the point. A daemon restart drops the
 * outstanding ones, and the browser mints another on its reconnect, which it is already built to do. */

// Long enough to survive a slow tunnel hop between the mint and the upgrade, short enough that a ticket which
// leaks is almost certainly already expired as well as already spent.
const TICKET_TTL_MS = 30_000;

export interface WsTickets {
    // The raw ticket, handed to the browser once. Nothing else can reproduce it.
    readonly mint: (identity: VerifiedIdentity) => string;
    // The identity this ticket was minted for, consuming it; undefined when unknown, spent, or expired.
    readonly redeem: (ticket: string) => VerifiedIdentity | undefined;
}

/* The gate the three upgrade handlers share: redeem the `?ticket=` on this URL or throw.
 *
 * Throwing rather than returning a verdict is what keeps the call sites honest — each is inside a try that
 * closes the socket with 1008, so a handler cannot forget to check the answer. Loopback mode (no `auth`) has no
 * gate on these routes at all and passes straight through, exactly as it did when they verified bearers.
 *
 * The identity is redeemed and dropped: these sockets are owner/member-equivalent by nature (a PTY is a shell),
 * and none of the three shows presence or attributes anything to a caller. Redemption is the authorization. */
export const redeemTicket = (services: { readonly auth: unknown; readonly wsTickets: WsTickets }, url: URL): void => {
    if (services.auth === undefined) {
        return;
    }
    if (services.wsTickets.redeem(url.searchParams.get("ticket") ?? "") === undefined) {
        throw new Error("invalid or expired websocket ticket");
    }
};

export const createWsTickets = (): WsTickets => {
    const tickets = new Map<string, { identity: VerifiedIdentity; expiresAt: number }>();
    return {
        mint: (identity) => {
            const ticket = randomBytes(32).toString("base64url");
            tickets.set(ticket, { identity, expiresAt: Date.now() + TICKET_TTL_MS });
            // Opportunistic sweep: a minted-but-never-redeemed ticket (a tab closed mid-connect) would otherwise
            // sit here until the daemon restarts. Bounded work — the map only ever holds a few seconds' worth.
            for (const [key, entry] of tickets) {
                if (entry.expiresAt < Date.now()) {
                    tickets.delete(key);
                }
            }
            return ticket;
        },
        redeem: (ticket) => {
            const entry = tickets.get(ticket);
            if (entry === undefined) {
                return undefined;
            }
            // Delete on ANY hit, expired or not: one lookup is all a ticket ever gets, so a replay of a
            // still-valid ticket finds nothing even if it arrives a millisecond later.
            tickets.delete(ticket);
            return entry.expiresAt < Date.now() ? undefined : entry.identity;
        },
    };
};
