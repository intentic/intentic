import { randomBytes, timingSafeEqual } from "node:crypto";

// File-scoped tickets for /workspace/media: a media element can't carry an Authorization header and makes many range
// requests over a playback, so a one-shot ws-ticket doesn't fit.
// A ticket names exactly one resolved absolute path (not the relative one the caller asked with, since that differs
// across each conversation's checkout), so a leaked ticket buys only that one file.
// Its life spans a watching session, not a request, so a paused-then-resumed playback doesn't die mid-film; bounded in
// memory, dropped on restart.

const TICKET_TTL_MS = 8 * 60 * 60 * 1000;

export interface MediaTickets {
    // A ticket for one resolved file, with the epoch ms it dies at, so the browser re-mints before it stalls.
    readonly mint: (absPath: string) => { readonly ticket: string; readonly expiresAt: number };
    // Is this ticket live and minted for this file? Doesn't consume it: a playback redeems it many times.
    readonly valid: (ticket: string, absPath: string) => boolean;
}

// Constant-time compare of the ticket's file binding, so timing can't reveal which files have live tickets.
const pathEquals = (a: string, b: string): boolean => {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
};

export const createMediaTickets = (): MediaTickets => {
    const tickets = new Map<string, { path: string; expiresAt: number }>();
    return {
        mint: (absPath) => {
            const ticket = randomBytes(32).toString("base64url");
            const expiresAt = Date.now() + TICKET_TTL_MS;
            tickets.set(ticket, { path: absPath, expiresAt });
            // Opportunistic sweep, like ws-tickets: a tab closed mid-playback leaves a ticket nobody will redeem again.
            for (const [key, entry] of tickets) {
                if (entry.expiresAt < Date.now()) {
                    tickets.delete(key);
                }
            }
            return { ticket, expiresAt };
        },
        valid: (ticket, absPath) => {
            const entry = tickets.get(ticket);
            if (entry === undefined) {
                return false;
            }
            if (entry.expiresAt < Date.now()) {
                tickets.delete(ticket);
                return false;
            }
            return pathEquals(entry.path, absPath);
        },
    };
};
