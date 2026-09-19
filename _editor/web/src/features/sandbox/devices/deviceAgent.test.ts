import type { Device } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { deviceAgentPanel } from "./deviceAgent";
import { deviceRow } from "./deviceRows";

// The agent panel's rules, checked without mounting the page: what it says about one device's agent, and
// when each of its two verbs is offered.

const NOW = 1_700_000_000_000;

type Report = NonNullable<Device[`report`]>;

// A live loop: `agentStalled` reads `lastTickAt`, so a fixture without one is neither live nor stalled.
const report = (overrides: Partial<Report> = {}): Report => ({
    hostname: `rog`,
    os: `linux`,
    pairings: [],
    ports: [],
    agent: { running: true, lastTickAt: NOW, build: `1.2.0`, installed: `1.2.0` },
    capturedAt: NOW,
    ...overrides,
});

// A connected, reachable, currently-reporting machine: the shape every case below varies one fact of.
const device = (overrides: Partial<Device> = {}): Device => ({
    key: `rog`,
    label: `rog`,
    hostId: `host-rog`,
    online: true,
    report: report(),
    ...overrides,
});

// `NOW` as the reading's own clock throughout: every verdict here that ages anything ages it against that.
const panelOf = (overrides: Partial<Device> = {}, held: Partial<Report> = {}, latest?: string) =>
    deviceAgentPanel(deviceRow(device({ report: report(held), ...overrides }), latest), latest, NOW);

const said = (overrides: Partial<Device> = {}, held: Partial<Report> = {}, latest?: string): string =>
    (panelOf(overrides, held, latest)?.notes ?? []).map((note) => note.text).join(` `);

// The long form the short lines were cut from: on hover, never on the page.
const hints = (overrides: Partial<Device> = {}, held: Partial<Report> = {}, latest?: string): string =>
    (panelOf(overrides, held, latest)?.notes ?? []).map((note) => note.hint ?? ``).join(` `);

const verbs = (overrides: Partial<Device> = {}, held: Partial<Report> = {}, latest?: string): string[] =>
    (panelOf(overrides, held, latest)?.actions ?? []).map((action) => action.label);

// ── the verbs are standing, not remedies ───────────────────────────────────

// The whole point of the group: an update this sandbox has to notice first is no update at all on a dev
// build, on a sandbox that never reached the registry, or on a release published since it last looked —
// and each of those used to mean typing `intentic-machine upgrade` on the machine itself.
test(`offers both verbs on an agent with nothing at all wrong with it`, () => {
    expect(verbs({}, {}, `1.2.0`)).toEqual([`Update agent`, `Restart agent`]);
    expect(panelOf({}, {}, `1.2.0`)?.blocked).toBeUndefined();
});

test(`offers both verbs on a sandbox that does not know which release is newest`, () => {
    expect(verbs()).toEqual([`Update agent`, `Restart agent`]);
});

// Update leads: it is what this group is opened for, and it restarts the loop on its way past, which makes
// Restart the narrower of the two rather than the first thing to try.
test(`leads with the update, since a restart is the narrower errand`, () => {
    expect(verbs({}, {}, `1.9.0`)[0]).toBe(`Update agent`);
});

// ── what the panel says ────────────────────────────────────────────────────

test(`states the build the loop is serving, its pid, and that it is running`, () => {
    const panel = panelOf({}, { agent: { running: true, lastTickAt: NOW, build: `1.2.0`, installed: `1.2.0`, pid: 4242 } }, `1.2.0`);
    expect(panel?.version).toBe(`1.2.0`);
    expect(panel?.facts).toEqual([`pid 4242`]);
    expect(panel?.state).toEqual({ word: `running`, variant: `success` });
});

// A settled agent says NOTHING. The line it used to carry ("Newest agent this sandbox knows of.") was printed
// under every environment of every machine and asked nothing of anybody; what Update is for on an agent wanting
// nothing lives on Update's own hint, where a reader reaching for the button already is.
test(`says nothing at all about an agent with nothing to ask for`, () => {
    expect(panelOf({}, {}, `1.2.0`)?.notes).toEqual([]);
    expect(verbs({}, {}, `1.2.0`)).toEqual([`Update agent`, `Restart agent`]);
});

// Whether this sandbox knows the newest release is a fact about this sandbox, not about the machine on screen,
// and a device page is no place to confess it: silent here too.
test(`stays silent when this sandbox knows no release to judge the build against`, () => {
    expect(panelOf()?.notes).toEqual([]);
    expect(panelOf({ hostId: undefined, online: undefined })?.notes).toEqual([]);
});

test(`names the published release, and what this device holds, when it is behind`, () => {
    expect(said({}, { agent: { running: true, lastTickAt: NOW, build: `1.1.0`, installed: `1.1.0` } }, `1.2.0`)).toBe(
        `Agent 1.2.0 has been published; this device has 1.1.0.`,
    );
    expect(panelOf({}, { agent: { running: true, lastTickAt: NOW, build: `1.1.0`, installed: `1.1.0` } }, `1.2.0`)?.notes[0]?.tone).toBe(`info`);
});

test(`says a stopped loop is why nothing reaches this device, and still offers the verbs`, () => {
    const stopped = { agent: { running: false, build: `1.2.0`, installed: `1.2.0` } };
    expect(said({}, stopped, `1.2.0`)).toBe(`Loop stopped — nothing reaches its folders or ports.`);
    expect(panelOf({}, stopped, `1.2.0`)?.state).toEqual({ word: `stopped`, variant: `warning` });
    expect(verbs({}, stopped, `1.2.0`)).toEqual([`Update agent`, `Restart agent`]);
});

test(`distinguishes a loop that has stopped making rounds from one that has stopped`, () => {
    const stalled = { agent: { running: true, lastTickAt: NOW - 61_000, build: `1.2.0`, installed: `1.2.0` } };
    expect(said({}, stalled, `1.2.0`)).toBe(`Loop stalled — what is below may be out of date.`);
    expect(hints({}, stalled, `1.2.0`)).toContain(`stopped making rounds`);
    expect(panelOf({}, stalled, `1.2.0`)?.state).toEqual({ word: `stalled`, variant: `warning` });
});

// A restart closes this one and a download would not, so it is its own sentence rather than "behind".
test(`asks about the loop, not a download, when only the running build is behind the installed one`, () => {
    const skewed = { agent: { running: true, lastTickAt: NOW, build: `1.1.0`, installed: `1.2.0` } };
    expect(said({}, skewed, `1.2.0`)).toBe(`Serving 1.1.0, 1.2.0 installed — a restart picks it up.`);
    expect(hints({}, skewed, `1.2.0`)).toContain(`keeps the build it started with until it restarts`);
});

// Two different errands, both true: the file on disk was replaced and never picked up, and something newer
// than that file has since been published. Neither hides the other.
test(`says both when the loop is behind its own file and the file is behind the registry`, () => {
    const notes = panelOf({}, { agent: { running: true, lastTickAt: NOW, build: `1.1.0`, installed: `1.2.0` } }, `1.3.0`)?.notes ?? [];
    expect(notes.map((note) => note.tone)).toEqual([`warning`, `info`]);
    expect(notes[0]?.text).toBe(`Serving 1.1.0, 1.2.0 installed — a restart picks it up.`);
    expect(notes[1]?.text).toBe(`Agent 1.3.0 has been published; this device has 1.2.0.`);
});

// ── where no click could land ──────────────────────────────────────────────

// Desktop sync carries folders and ports, never commands: this machine's agent can only be updated on it.
test(`drops the verbs and names the missing door on a sync-only enrollment`, () => {
    const syncOnly = { hostId: undefined, online: undefined };
    expect(verbs(syncOnly)).toEqual([]);
    expect(panelOf(syncOnly)?.blocked?.text).toBe(`Enrolled for syncing only.`);
    expect(panelOf(syncOnly)?.blocked?.hint).toContain(`connected as a device`);
    // The version is still worth stating: it is the fact somebody walked to the machine to check.
    expect(panelOf(syncOnly)?.version).toBe(`1.2.0`);
});

// The badge reads `offline` and the concerns strip carries the errand; saying it a third time here is how one
// silence came to be stated four times on one page.
test(`drops the verbs on a connected device that is not answering, and says nothing about it`, () => {
    expect(verbs({ online: false })).toEqual([]);
    expect(panelOf({ online: false })?.blocked).toBeUndefined();
});

// Both verbs above end this machine's socket on purpose, and so does any CLI action that reloads its config: a
// drop this young is the machine on its way back, and the reading that is missing was there a moment ago.
test(`reads a socket dropped seconds ago as a reconnection, not as silence`, () => {
    const dropped = { online: false, gap: `offline`, lastSeen: NOW - 3_000, report: undefined } as const;
    expect(panelOf(dropped)?.state).toEqual({ word: `reconnecting`, variant: `neutral` });
    expect(panelOf(dropped)?.blocked?.text).toBe(`Reconnecting — its buttons come back with it.`);
    // Still no verbs: nothing can run on a machine holding no socket, however briefly it has held none.
    expect(verbs(dropped)).toEqual([]);
});

// The window is what makes the reconnecting line honest: past it the machine is away, the badge says so, and
// this panel hands the sentence back to the concerns strip that owns it.
test(`hands the silence back to the concerns strip once the drop is older than the window`, () => {
    const away = { online: false, gap: `offline`, lastSeen: NOW - 60_000, report: undefined } as const;
    expect(panelOf(away)?.state).toEqual({ word: `not reported`, variant: `neutral` });
    expect(panelOf(away)?.blocked).toBeUndefined();
});

// Every gap already has a sentence of its own in the concerns strip (deviceAttention.ts), each naming its own
// errand. This panel used to restate all four in a few words each, directly beneath them.
test(`leaves every gap to the concerns strip rather than restating it under the buttons it removed`, () => {
    for (const gap of [`scope-off`, `no-agent`, `offline`] as const) {
        expect(verbs({ gap })).toEqual([]);
        expect(panelOf({ gap })?.blocked).toBeUndefined();
    }
});

// Nothing to state and nothing to press: a heading over an empty card.
test(`draws no panel for a machine with neither a version nor a command door`, () => {
    expect(deviceAgentPanel(deviceRow({ key: `x`, label: `x` }, undefined), undefined, NOW)).toBeUndefined();
});

// The case the old view answered with "re-run its install": a device holding a socket but sending no report
// is usually running an agent from before machine reports — exactly what an update replaces. Its socket is
// what the verbs travel over, so it keeps them, and its version is whatever its hello frame announced.
test(`keeps the verbs for a connected device that has never reported`, () => {
    const never = { key: `x`, label: `x`, hostId: `host-x`, online: true, gap: `unreported`, agentVersion: `1.0.0` } as const;
    const panel = deviceAgentPanel(deviceRow(never, `1.2.0`), `1.2.0`, NOW);
    expect(panel?.version).toBe(`1.0.0`);
    expect(panel?.state).toEqual({ word: `not reported`, variant: `neutral` });
    expect(panel?.actions.map((action) => action.op)).toEqual([`upgrade`, `restart`]);
    expect(panel?.blocked).toBeUndefined();
});
