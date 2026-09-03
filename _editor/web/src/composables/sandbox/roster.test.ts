import type { SandboxSummary } from "@intentic-app/api-contract";
import { expect, it } from "vitest";
import { connectedSandboxes, unfinishedSandboxes } from "./roster";

/* The partition every sandbox list draws itself from. Its own tests because the two halves are read as
 * OPPOSITE promises: one is a place you can go, the other an errand with a step left in it, and the switcher
 * spent a release conflating them behind a chip, which is how clicking a sandbox threw you out of the
 * workspace you were standing in. */

const row = (over: Partial<SandboxSummary>): SandboxSummary =>
    ({
        id: `s1`,
        name: `workspace`,
        image: null,
        daemonUrl: null,
        lastSeenAt: null,
        setupCodeClaimedAt: null,
        token: `tok`,
        role: `owner`,
        providedAddress: false,
        hosted: null,
        ...over,
    }) as SandboxSummary;

const SEEN = `2026-08-17T00:00:00.000Z`;

it(`counts a sandbox that has checked in as somewhere to switch to`, () => {
    const live = row({ id: `live`, lastSeenAt: SEEN });
    expect(connectedSandboxes([live])).toEqual([live]);
    expect(unfinishedSandboxes([live])).toEqual([]);
});

// The one that started this: a row minted by /setup and never started is not a sandbox you can go to.
it(`counts a sandbox that has never checked in as an unfinished setup`, () => {
    const draft = row({ id: `draft` });
    expect(connectedSandboxes([draft])).toEqual([]);
    expect(unfinishedSandboxes([draft])).toEqual([draft]);
});

/* BEING OFFLINE IS NOT BEING UNFINISHED, and this is the distinction the old "Setup" chip could not carry. A
 * sandbox that ran once keeps its stamp forever: the daemon being down right now is the connection dot's
 * story, and demoting it out of the switcher would take away the reader's way back to it. */
it(`keeps a sandbox that ran once switchable even with no daemon URL`, () => {
    const down = row({ id: `down`, daemonUrl: null, lastSeenAt: SEEN });
    expect(connectedSandboxes([down])).toEqual([down]);
    expect(unfinishedSandboxes([down])).toEqual([]);
});

// Order is preserved across the split, because the switcher's Alt+N slots are positions in the first half.
it(`splits a mixed list in place, keeping each half in the list's own order`, () => {
    const rows = [row({ id: `a`, lastSeenAt: SEEN }), row({ id: `b` }), row({ id: `c`, lastSeenAt: SEEN }), row({ id: `d` })];
    expect(connectedSandboxes(rows).map((entry) => entry.id)).toEqual([`a`, `c`]);
    expect(unfinishedSandboxes(rows).map((entry) => entry.id)).toEqual([`b`, `d`]);
});
