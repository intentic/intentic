import { join } from "node:path";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { createMediaTickets } from "./media-tickets.js";

const FILM = join(WORKSPACE_ROOT, "film.mp4");

// A media ticket lives for a watching session, hours longer than the sign-in that minted it may, so it goes wherever
// that person's access goes: one person's on a removal or re-grade, everybody's on signing every browser out.
test("revoking one person drops the tickets they minted and nobody else's; revoking all drops every ticket", () => {
    const tickets = createMediaTickets();
    const removed = tickets.mint(FILM, undefined, "Viewer@Example.com").ticket;
    const kept = tickets.mint(FILM, undefined, "owner@example.com").ticket;
    const nameless = tickets.mint(FILM).ticket;

    // Compared case-insensitively, as the roster's emails are.
    tickets.revoke("viewer@example.com");
    expect(tickets.valid(removed, FILM)).toBe(false);
    expect(tickets.valid(kept, FILM)).toBe(true);
    // A ticket minted without an email (a loopback daemon's) answers to nobody's removal, only to revoking all.
    expect(tickets.bound(nameless)).toBe(FILM);

    tickets.revoke();
    expect(tickets.valid(kept, FILM)).toBe(false);
    expect(tickets.bound(nameless)).toBeUndefined();
});
