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
    sandboxes: [],
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

const panelOf = (overrides: Partial<Device> = {}, held: Partial<Report> = {}, latest?: string) =>
    deviceAgentPanel(deviceRow(device({ report: report(held), ...overrides }), latest), latest);

const said = (overrides: Partial<Device> = {}, held: Partial<Report> = {}, latest?: string): string =>
    (panelOf(overrides, held, latest)?.notes ?? []).map((note) => note.text).join(` `);

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

// A settled agent still gets a line, or the two buttons beside it stand unexplained.
test(`says the agent is the newest it knows of when it has nothing to ask for`, () => {
    expect(said({}, {}, `1.2.0`)).toBe(`This is the newest agent this sandbox knows of.`);
    expect(panelOf({}, {}, `1.2.0`)?.notes[0]?.tone).toBeUndefined();
});

// The case that made the standing button necessary, said plainly rather than left as silence — and without
// naming the button on a machine that doesn't get one.
test(`admits it cannot judge the build when this sandbox knows no release`, () => {
    expect(said()).toContain(`doesn't know which agent release is newest`);
    expect(said()).toContain(`Update fetches the newest there is`);
    expect(said({ hostId: undefined, online: undefined })).toContain(`doesn't know which agent release is newest`);
    expect(said({ hostId: undefined, online: undefined })).not.toContain(`Update fetches`);
});

test(`names the published release, and what this device holds, when it is behind`, () => {
    expect(said({}, { agent: { running: true, lastTickAt: NOW, build: `1.1.0`, installed: `1.1.0` } }, `1.2.0`)).toBe(
        `Agent 1.2.0 has been published; this device has 1.1.0.`,
    );
    expect(panelOf({}, { agent: { running: true, lastTickAt: NOW, build: `1.1.0`, installed: `1.1.0` } }, `1.2.0`)?.notes[0]?.tone).toBe(`info`);
});

test(`says a stopped loop is why nothing reaches this device, and still offers the verbs`, () => {
    const stopped = { agent: { running: false, build: `1.2.0`, installed: `1.2.0` } };
    expect(said({}, stopped, `1.2.0`)).toContain(`isn't running`);
    expect(panelOf({}, stopped, `1.2.0`)?.state).toEqual({ word: `stopped`, variant: `warning` });
    expect(verbs({}, stopped, `1.2.0`)).toEqual([`Update agent`, `Restart agent`]);
});

test(`distinguishes a loop that has stopped making rounds from one that has stopped`, () => {
    const stalled = { agent: { running: true, lastTickAt: NOW - 61_000, build: `1.2.0`, installed: `1.2.0` } };
    expect(said({}, stalled, `1.2.0`)).toContain(`stopped making rounds`);
    expect(panelOf({}, stalled, `1.2.0`)?.state).toEqual({ word: `stalled`, variant: `warning` });
});

// A restart closes this one and a download would not, so it is its own sentence rather than "behind".
test(`asks about the loop, not a download, when only the running build is behind the installed one`, () => {
    const skewed = { agent: { running: true, lastTickAt: NOW, build: `1.1.0`, installed: `1.2.0` } };
    expect(said({}, skewed, `1.2.0`)).toBe(
        `It is serving agent 1.1.0 while 1.2.0 is installed there: a loop keeps the build it started with until it restarts.`,
    );
});

// Two different errands, both true: the file on disk was replaced and never picked up, and something newer
// than that file has since been published. Neither hides the other.
test(`says both when the loop is behind its own file and the file is behind the registry`, () => {
    const notes = panelOf({}, { agent: { running: true, lastTickAt: NOW, build: `1.1.0`, installed: `1.2.0` } }, `1.3.0`)?.notes ?? [];
    expect(notes.map((note) => note.tone)).toEqual([`warning`, `info`]);
    expect(notes[0]?.text).toContain(`serving agent 1.1.0 while 1.2.0 is installed there`);
    expect(notes[1]?.text).toBe(`Agent 1.3.0 has been published; this device has 1.2.0.`);
});

// ── where no click could land ──────────────────────────────────────────────

// Desktop sync carries folders and ports, never commands: this machine's agent can only be updated on it.
test(`drops the verbs and names the missing door on a sync-only enrollment`, () => {
    const syncOnly = { hostId: undefined, online: undefined };
    expect(verbs(syncOnly)).toEqual([]);
    expect(panelOf(syncOnly)?.blocked).toContain(`enrolled for syncing only`);
    // The version is still worth stating: it is the fact somebody walked to the machine to check.
    expect(panelOf(syncOnly)?.version).toBe(`1.2.0`);
});

test(`drops the verbs on a connected device that is not answering`, () => {
    expect(verbs({ online: false })).toEqual([]);
    expect(panelOf({ online: false })?.blocked).toContain(`isn't answering`);
});

// Each shut door gets its own sentence: a switch nobody turned on is a different errand from a laptop asleep,
// and from a machine that has no agent to update at all.
test(`names the shut door rather than calling every one of them silence`, () => {
    expect(verbs({ gap: `scope-off` })).toEqual([]);
    expect(panelOf({ gap: `scope-off` })?.blocked).toContain(`"Run commands" on its capability card`);
    expect(verbs({ gap: `no-agent` })).toEqual([]);
    expect(panelOf({ gap: `no-agent` })?.blocked).toContain(`no agent to update`);
});

// Nothing to state and nothing to press: a heading over an empty card.
test(`draws no panel for a machine with neither a version nor a command door`, () => {
    expect(deviceAgentPanel(deviceRow({ key: `x`, label: `x` }, undefined), undefined)).toBeUndefined();
});

// The case the old view answered with "re-run its install": a device holding a socket but sending no report
// is usually running an agent from before machine reports — exactly what an update replaces. Its socket is
// what the verbs travel over, so it keeps them, and its version is whatever its hello frame announced.
test(`keeps the verbs for a connected device that has never reported`, () => {
    const never = { key: `x`, label: `x`, hostId: `host-x`, online: true, gap: `unreported`, agentVersion: `1.0.0` } as const;
    const panel = deviceAgentPanel(deviceRow(never, `1.2.0`), `1.2.0`);
    expect(panel?.version).toBe(`1.0.0`);
    expect(panel?.state).toEqual({ word: `not reported`, variant: `neutral` });
    expect(panel?.actions.map((action) => action.op)).toEqual([`upgrade`, `restart`]);
    expect(panel?.blocked).toBeUndefined();
});
