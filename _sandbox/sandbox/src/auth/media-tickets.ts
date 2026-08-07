import { randomBytes, timingSafeEqual } from "node:crypto";

/* File-scoped tickets for /workspace/media — the one route a <video>/<audio> element fetches itself.
 *
 * A media element cannot carry an Authorization header, and unlike the WebSocket upgrades it does not make ONE
 * request: it makes dozens of Range requests over the life of a playback, at times the app never sees (a seek,
 * a re-buffer after a stall, a resume from the OS media keys). So the one-shot ws-ticket is the wrong shape
 * here — the second request would find its ticket already spent.
 *
 * What replaces "worthless after one use" as the containment is SCOPE. A ticket names exactly one RESOLVED
 * file — the absolute path the mint's own guards produced, not the relative one the caller asked with — and the
 * route refuses it for any other, so the worst a leaked ticket buys is the file its holder was already
 * watching, not the file API. Resolved rather than relative because there is more than one workspace: the same
 * relative path names a different file in the shared tree and in each conversation's checkout
 * (workspace/workspace-scope.ts), and a ticket bound to the shared spelling would carry across all of them.
 * That is a strictly smaller grant than the bearer it stands in for, which is what makes the longer life
 * affordable: the alternative is not "no credential in the URL", it is "no video".
 *
 * The life is a WATCHING session, not a request. A three-hour recording paused over lunch and resumed is the
 * ordinary case, and a player that dies mid-film because its credential aged out is the failure this length
 * exists to avoid — re-minting mid-playback means swapping the element's src, which resets the picture and the
 * position. Bounded the same way ws-tickets are: in memory, so a daemon restart drops every outstanding one.
 */

const TICKET_TTL_MS = 8 * 60 * 60 * 1000;

export interface MediaTickets {
    // A ticket for one resolved file, with the epoch ms it dies at so the browser can re-mint on the next open
    // rather than discovering the expiry as a stalled player.
    readonly mint: (absPath: string) => { readonly ticket: string; readonly expiresAt: number };
    // Is this ticket live AND minted for this file? Does not consume it — a playback redeems it many times.
    readonly valid: (ticket: string, absPath: string) => boolean;
}

// Constant-time compare of the ticket's OWN file binding, so a caller can't probe which files have live tickets
// by timing. Lengths differ freely (a length mismatch is an immediate miss and tells nothing).
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
            // Opportunistic sweep, like ws-tickets: a tab closed mid-playback leaves a ticket nobody will
            // redeem again. Bounded work — a browsing session mints one per media file it opens.
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
