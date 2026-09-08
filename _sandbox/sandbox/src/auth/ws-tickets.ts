import { randomBytes } from "node:crypto";
import type { MemberRole } from "@intentic/sandbox-contract";
import { roleAtLeast } from "@intentic/sandbox-contract";
import type { Caller } from "./auth.js";

// One-shot tickets for the WebSocket upgrades (/system/terminal, /system/browser-profile, /system/browser-view): minted
// over bearer-authenticated HTTP since a WS can't carry an Authorization header. Good for exactly one upgrade, for
// seconds, in memory only, and never carries an identity a log reader could extract.

// Long enough to survive a slow tunnel hop; short enough that a leaked ticket is already spent.
const TICKET_TTL_MS = 30_000;

export interface WsTickets {
    // The raw ticket, handed to the browser once; nothing else can reproduce it.
    readonly mint: (caller: Caller) => string;
    // The caller this ticket was minted for, consuming it; undefined when unknown, spent, or expired.
    readonly redeem: (ticket: string) => Caller | undefined;
    // Drops outstanding tickets, all or one member's; auth/connections.ts closes already-open sockets separately.
    readonly revoke: (email?: string) => void;
}

// Gate shared by the three upgrade handlers: redeems `?ticket=`, holds it to this socket's role floor, or throws. Each
// socket needs a different tier, so the check runs at redemption against the role the ticket was minted under.
export const redeemTicket = (
    services: { readonly auth: unknown; readonly wsTickets: WsTickets },
    url: URL,
    floor: MemberRole,
): Caller | undefined => {
    if (services.auth === undefined) {
        return undefined;
    }
    const caller = services.wsTickets.redeem(url.searchParams.get("ticket") ?? "");
    if (caller === undefined) {
        throw new Error("invalid or expired websocket ticket");
    }
    if (!roleAtLeast(caller.role, floor)) {
        throw new Error(`${floor} access required`);
    }
    return caller;
};

export const createWsTickets = (): WsTickets => {
    const tickets = new Map<string, { identity: Caller; expiresAt: number }>();
    return {
        mint: (identity) => {
            const ticket = randomBytes(32).toString("base64url");
            tickets.set(ticket, { identity, expiresAt: Date.now() + TICKET_TTL_MS });
            // Sweeps expired tickets so an unredeemed one doesn't sit until restart; the map holds only seconds' worth.
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
            // Deletes on any hit, expired or not: one lookup per ticket, so even a same-millisecond replay finds
            // nothing.
            tickets.delete(ticket);
            return entry.expiresAt < Date.now() ? undefined : entry.identity;
        },
        revoke: (email) => {
            const target = email?.toLowerCase();
            for (const [ticket, entry] of tickets) {
                if (target === undefined || entry.identity.email.toLowerCase() === target) {
                    tickets.delete(ticket);
                }
            }
        },
    };
};
