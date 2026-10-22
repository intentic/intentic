import type { SandboxSummary } from "@intentic/api-contract";
import { type LocalFace, localSandboxId } from "../../../app/environments/local";
import { connectedSandboxes, switchableSandboxes, unfinishedSandboxes } from "./roster";

/* The partition every sandbox list draws itself from. */

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

// Finishing it would open /setup, which starts a sandbox of the member's own rather than resuming somebody else's.
it(`leaves a shared sandbox its owner never finished off the member's errands`, () => {
    const shared = row({ id: `shared`, role: `maintainer`, token: null });
    expect(connectedSandboxes([shared])).toEqual([]);
    expect(unfinishedSandboxes([shared])).toEqual([]);
});

/* BEING OFFLINE IS NOT BEING UNFINISHED, and this is the distinction the old "Setup" chip could not carry. */
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

/* ONE LIST OF PLACES TO GO, which the switcher, the phone's menu and the home rail all draw. */

// The home rail drew the account's raw rows: a setup never finished showed as a tile that opened onto "not connected".
it(`offers the checked-in sandboxes only, in the list's own order`, () => {
    const rows = [row({ id: `draft`, name: `W` }), row({ id: `a`, lastSeenAt: SEEN }), row({ id: `b`, lastSeenAt: SEEN })];
    expect(switchableSandboxes(rows).map((entry) => entry.id)).toEqual([`a`, `b`]);
});

// A desktop folder window lists its own folder first (desktop-app local/platform.ts); it is where the window stands.
it(`leaves a folder window's own folder out of the places to go`, () => {
    const face: LocalFace = { id: `f1`, name: `work`, path: `/work`, daemonUrl: `http://127.0.0.1:1`, token: `t` };
    window.__INTENTIC_LOCAL__ = face;
    try {
        const rows = [row({ id: localSandboxId(face), lastSeenAt: SEEN }), row({ id: `a`, lastSeenAt: SEEN })];
        expect(switchableSandboxes(rows).map((entry) => entry.id)).toEqual([`a`]);
    } finally {
        delete window.__INTENTIC_LOCAL__;
    }
});
