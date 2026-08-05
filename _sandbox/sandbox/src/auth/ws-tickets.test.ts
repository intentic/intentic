import { expect, test, vi } from "vitest";
import { createWsTickets, redeemTicket } from "./ws-tickets.js";

const IDENTITY = { email: "owner@x.com" };
const urlWith = (ticket: string): URL => new URL(`ws://sandbox.example/system/terminal?ticket=${encodeURIComponent(ticket)}`);

test("a ticket redeems once, for the identity it was minted for", () => {
    const tickets = createWsTickets();
    const ticket = tickets.mint(IDENTITY);
    expect(tickets.redeem(ticket)).toEqual(IDENTITY);
});

/* Single use is the property that makes it safe to put in a URL at all: the value reaches Cloudflare's edge
 * logs and the tunnel connector's, and it has to be worthless by the time anyone reads them. */
test("a replayed ticket is refused, even immediately", () => {
    const tickets = createWsTickets();
    const ticket = tickets.mint(IDENTITY);
    expect(tickets.redeem(ticket)).toEqual(IDENTITY);
    expect(tickets.redeem(ticket)).toBeUndefined();
});

test("an unminted or empty ticket is refused", () => {
    const tickets = createWsTickets();
    expect(tickets.redeem("not-a-ticket")).toBeUndefined();
    expect(tickets.redeem("")).toBeUndefined();
});

test("a ticket expires, so one that leaks and is never used cannot be picked up later", () => {
    vi.useFakeTimers();
    try {
        const tickets = createWsTickets();
        const ticket = tickets.mint(IDENTITY);
        vi.advanceTimersByTime(31_000);
        expect(tickets.redeem(ticket)).toBeUndefined();
    } finally {
        vi.useRealTimers();
    }
});

test("tickets are distinct and unguessable-width, so one does not predict the next", () => {
    const tickets = createWsTickets();
    const minted = Array.from({ length: 16 }, () => tickets.mint(IDENTITY));
    expect(new Set(minted).size).toBe(minted.length);
    for (const ticket of minted) {
        expect(ticket.length).toBeGreaterThanOrEqual(43); // 32 random bytes, base64url
    }
});

/* The shared gate the three upgrade handlers call. It throws rather than returning a verdict so a handler
 * cannot forget to check — each call sits in a try that closes the socket 1008. */
test("redeemTicket throws on a bad ticket and passes a good one", () => {
    const services = { auth: {}, wsTickets: createWsTickets() };
    expect(() => redeemTicket(services, urlWith("nope"))).toThrow();
    expect(() => redeemTicket(services, urlWith(services.wsTickets.mint(IDENTITY)))).not.toThrow();
});

// Loopback mode (tests, the host-internal preview) gates none of these routes and never minted a ticket —
// requiring one there would break the very compositions that have no auth to satisfy.
test("redeemTicket is a no-op without an authorizer", () => {
    expect(() => redeemTicket({ auth: undefined, wsTickets: createWsTickets() }, urlWith(""))).not.toThrow();
});
