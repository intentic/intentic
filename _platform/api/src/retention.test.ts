import { describe, expect, it } from "vitest";
import { protectedTunnelNames } from "./retention.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.parse(`2026-08-12T12:00:00Z`);
const daysAgo = (days: number): Date => new Date(now - days * DAY_MS);
const digest = (letter: string): string => letter.repeat(64);
const name = (letter: string): string => `sandbox-${letter.repeat(12)}`;

// The DB's answer to "whose tunnel is the idle heuristic forbidden to touch" — the function the daily reap's
// exclude set is built from, and the reason a sleeping hosted machine (whose connector is disconnected BY
// DESIGN) can never be reaped into permanent unreachability again.
describe(`protectedTunnelNames`, () => {
    const windows = { now, reapAfterMs: 7 * DAY_MS, pruneAfterMs: 45 * DAY_MS };

    it(`always protects hosted rows — a stopped machine's idle tunnel is the idle-stop working, not abandonment`, () => {
        const names = protectedTunnelNames([{ tokenDigest: digest(`a`), lastSeenAt: daysAgo(300), createdAt: daysAgo(400), hosted: true }], windows);
        expect(names.has(name(`a`))).toBe(true);
    });

    it(`protects the recently seen and the freshly created; releases the long-offline and the abandoned setup`, () => {
        const names = protectedTunnelNames(
            [
                // Seen last week — a laptop that was simply off.
                { tokenDigest: digest(`b`), lastSeenAt: daysAgo(7), createdAt: daysAgo(100), hosted: false },
                // Offline past the prune window — its ~10 records go back to the zone, the row heals after.
                { tokenDigest: digest(`c`), lastSeenAt: daysAgo(60), createdAt: daysAgo(100), hosted: false },
                // A setup started yesterday: never connected, but still someone's work in progress.
                { tokenDigest: digest(`d`), lastSeenAt: null, createdAt: daysAgo(1), hosted: false },
                // A setup abandoned a month ago: never connected, past the reap window.
                { tokenDigest: digest(`e`), lastSeenAt: null, createdAt: daysAgo(30), hosted: false },
            ],
            windows,
        );
        expect([...names].toSorted()).toEqual([name(`b`), name(`d`)]);
    });

    it(`pruneAfterDays 0 protects every row — offline sandboxes then keep their records forever`, () => {
        const names = protectedTunnelNames(
            [
                { tokenDigest: digest(`c`), lastSeenAt: daysAgo(500), createdAt: daysAgo(600), hosted: false },
                // The never-connected abandoned setup stays prunable: 0 turns off the inactivity prune, not
                // the reclaim of rows nothing ever ran on.
                { tokenDigest: digest(`e`), lastSeenAt: null, createdAt: daysAgo(30), hosted: false },
            ],
            { ...windows, pruneAfterMs: 0 },
        );
        expect(names.has(name(`c`))).toBe(true);
        expect(names.has(name(`e`))).toBe(false);
    });
});
