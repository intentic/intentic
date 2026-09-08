import type { Device } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { deviceAttention } from "./deviceAttention";
import {
    boardBody,
    deviceRow,
    deviceRows,
    deviceState,
    deviceSwitches,
    deviceTally,
    deviceTone,
    isSelf,
    rowMatches,
    showFilter,
} from "./deviceRows";
import { boardRoute, deviceRoute, selectedKey } from "./deviceLinks";
import { manageBlock } from "./deviceFacts";

// The board's and the device page's shared rules, checked without mounting either: which machine reads as
// live, what a card says about it, and what it wants from the reader.

// One instant for every judgement below, so a threshold is crossed on purpose.
const NOW = 1_700_000_000_000;

type Report = NonNullable<Device[`report`]>;

// A live loop: `agentStalled` reads `lastTickAt`, so a fixture without one is neither live nor stalled.
const report = (overrides: Partial<Report> = {}): Report => ({
    hostname: `rog`,
    os: `linux`,
    sandboxes: [],
    pairings: [],
    ports: [],
    agent: { running: true, lastTickAt: NOW },
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

// Two axes, kept apart: what the daemon says about the machine, and what the machine said about itself.
const row = (overrides: Partial<Device> = {}, held: Partial<Report> = {}, latest?: string) =>
    deviceRow(device({ report: report(held), ...overrides }), latest, NOW);

// ── which machine reads as live ─────────────────────────────────────────────

test(`calls a reachable, freshly-reported machine live`, () => {
    expect(deviceState(device(), NOW)).toBe(`live`);
    expect(deviceTone(device(), NOW)).toBe(`success`);
});

test(`calls a machine that has not reported in a minute gone quiet`, () => {
    const quiet = device({ report: report({ capturedAt: NOW - 61_000 }) });
    expect(deviceState(quiet, NOW)).toBe(`gone quiet`);
    expect(deviceTone(quiet, NOW)).toBe(`warning`);
});

test(`agrees with itself about a dead loop: the word is amber, so it cannot read "live"`, () => {
    const dead = device({ report: report({ agent: { running: false } }) });
    expect(deviceState(dead, NOW)).toBe(`needs attention`);
    expect(deviceTone(dead, NOW)).toBe(`warning`);
});

test(`calls a live process with a dead loop the same errand as a stopped one`, () => {
    const stalled = device({ report: report({ agent: { running: true, lastTickAt: NOW - 61_000 } }) });
    expect(deviceState(stalled, NOW)).toBe(`needs attention`);
    expect(deviceTone(stalled, NOW)).toBe(`warning`);
});

test(`keeps an asleep machine neutral: offline is a state, not a fault`, () => {
    const asleep = device({ gap: `offline`, online: false, report: undefined });
    expect(deviceState(asleep, NOW)).toBe(`offline`);
    expect(deviceTone(asleep, NOW)).toBe(`neutral`);
});

test(`puts the machines worth reading first, and breaks ties by name`, () => {
    const rows = deviceRows(
        [
            device({ key: `zed`, label: `zed`, gap: `offline`, online: false, report: undefined }),
            device({ key: `beta`, label: `beta` }),
            device({ key: `alpha`, label: `alpha` }),
            device({ key: `dead`, label: `dead`, report: report({ agent: { running: false } }) }),
        ],
        undefined,
        NOW,
    );
    expect(rows.map((entry) => entry.device.label)).toEqual([`alpha`, `beta`, `dead`, `zed`]);
});

// ── what a card says without being expanded ────────────────────────────────

const PAIRED: Partial<Report> = {
    pairings: [{ sandboxId: `work-abc`, mode: `sync`, localDir: `/home/ada/work`, mutagenStatus: `watching` }],
    ports: [{ port: 8788, host: `127.0.0.1`, sandboxId: `work-abc`, state: `mirrored`, command: `node vite.js` }],
    sandboxes: [{ slug: `work-abc`, container: `sandbox-work-abc`, name: `intentic-dev`, running: true, image: `img:1` }],
};

// Names a sandbox with nothing but a folder, so a card can be given any number of them.
const folders = (...ids: string[]): Partial<Report> => ({
    pairings: ids.map((id) => ({ sandboxId: id, mode: `sync` as const, localDir: `/w/${id}` })),
});

test(`names every sandbox the machine holds, and what its ports came to`, () => {
    const body = boardBody(row({}, PAIRED), ``, undefined, NOW);
    expect(body.lines.map((line) => line.title)).toEqual([`intentic-dev`]);
    expect(body.lines[0]?.running).toBe(true);
    expect(body.lines[0]?.facts).toContain(`1 port`);
    expect(body.more).toBe(0);
});

test(`says how the sandbox reaches the machine, and which build its agent serves`, () => {
    const body = boardBody(row({ sync: { machine: `rog`, mode: `sync`, seenAt: NOW }, agentVersion: `1.2.0` }, PAIRED), ``, undefined, NOW);
    expect(body.doors).toEqual([`desktop sync`, `commands`, `agent 1.2.0`]);
});

test(`caps the lines it draws and counts what it left out`, () => {
    const body = boardBody(row({}, folders(`a`, `b`, `c`, `d`, `e`)), ``, undefined, NOW);
    expect(body.lines).toHaveLength(3);
    expect(body.more).toBe(2);
});

test(`draws every match while the filter is set, so a port search never lands off the list`, () => {
    const held: Partial<Report> = { ...folders(`a`, `b`, `c`, `d`), ports: [{ port: 8788, host: `127.0.0.1`, sandboxId: `d`, state: `mirrored` }] };
    const body = boardBody(row({}, held), `8788`, undefined, NOW);
    expect(body.lines.map((line) => line.title)).toEqual([`d`]);
    expect(body.more).toBe(0);
});

test(`separates what is wrong with the machine from what is wrong with its sandboxes`, () => {
    const body = boardBody(row({}, { ...PAIRED, agent: { running: false } }), ``, undefined, NOW);
    expect(body.warnings).toEqual([`agent stopped`]);
    expect(body.lines[0]?.warnings).toEqual([]);
});

test(`marks the sandbox serving this page, and only when both slugs are known`, () => {
    expect(boardBody(row({}, PAIRED), ``, `work-abc`, NOW).lines[0]?.self).toBe(true);
    // Two unknowns must not compare equal: a pairing with no container on an unknown-URL sandbox is not "you".
    const bare: Partial<Report> = { pairings: PAIRED.pairings };
    expect(boardBody(row({}, bare), ``, undefined, NOW).lines[0]?.self).toBe(false);
});

test(`finds a machine by a port number, by its sandbox, and by its folder`, () => {
    const entry = row({}, PAIRED);
    expect(rowMatches(entry, `8788`)).toBe(true);
    expect(rowMatches(entry, `intentic-dev`)).toBe(true);
    expect(rowMatches(entry, `/home/ada`)).toBe(true);
    expect(rowMatches(entry, `nothing-here`)).toBe(false);
});

test(`offers no filter over a board small enough to read`, () => {
    expect(showFilter([row()])).toBe(false);
    expect(showFilter([row(), row(), row()])).toBe(true);
    // Or over one machine holding more sandboxes than a reader can hold in their head.
    expect(showFilter([row({}, folders(`a`, `b`, `c`, `d`))])).toBe(true);
});

test(`counts the fleet's sandboxes by state, and keeps "running" visible at zero`, () => {
    const stopped: Partial<Report> = {
        ...PAIRED,
        sandboxes: [{ slug: `work-abc`, container: `sandbox-work-abc`, running: false, image: `img:1` }],
    };
    const tally = deviceTally([row({}, PAIRED), row({ key: `omen`, label: `omen` }, stopped)]);
    expect(tally.find((item) => item.label === `running`)?.value).toBe(1);
    expect(tally.find((item) => item.label === `running`)?.always).toBe(true);
    expect(tally.find((item) => item.label === `stopped`)?.value).toBe(1);
});

// ── the machine-wide switches ──────────────────────────────────────────────

const twoPairings = (overrides: { paused?: boolean; mirroring?: `on` | `off` } = {}): Partial<Report> => ({
    pairings: [
        { sandboxId: `a`, mode: `sync`, localDir: `/w/a`, ...overrides },
        { sandboxId: `b`, mode: `sync`, localDir: `/w/b`, ...overrides },
    ],
});

test(`points each switch whichever way the machine currently says`, () => {
    const on = deviceSwitches(row({}, twoPairings()));
    expect(on.map((half) => [half.label, half.word, half.actions.map((action) => action.label)])).toEqual([
        [`File syncing`, `on`, [`Pause all`]],
        [`Port mirroring`, `on`, [`Stop all`]],
    ]);
    const off = deviceSwitches(row({}, twoPairings({ paused: true, mirroring: `off` })));
    expect(off.map((half) => [half.word, half.actions.map((action) => action.label)])).toEqual([
        [`paused`, [`Resume all`]],
        [`off`, [`Start all`]],
    ]);
});

test(`says which pairings disagree and offers both directions`, () => {
    const mixed: Partial<Report> = {
        pairings: [
            { sandboxId: `a`, mode: `sync`, localDir: `/w/a`, paused: true },
            { sandboxId: `b`, mode: `sync`, localDir: `/w/b` },
        ],
    };
    const [sync] = deviceSwitches(row({}, mixed));
    expect(sync?.note).toBe(`1 of 2 paused`);
    expect(sync?.scope).toBe(`all 2 sandboxes`);
    expect(sync?.actions.map((action) => action.label)).toEqual([`Resume all`, `Pause all`]);
});

test(`drops the machine-wide switches over a single pairing, where a row's own button says it better`, () => {
    expect(deviceSwitches(row({}, PAIRED))).toEqual([]);
});

test(`draws no file-sync switch on a machine that only mirrors ports`, () => {
    const mirrors: Partial<Report> = { pairings: [{ sandboxId: `a`, mode: `mirror` }, { sandboxId: `b`, mode: `mirror` }] };
    expect(deviceSwitches(row({}, mirrors)).map((half) => half.label)).toEqual([`Port mirroring`]);
});

test(`states the halves without offering the switches on a machine it cannot reach`, () => {
    expect(deviceSwitches(row({ online: false }, twoPairings()))).toEqual([]);
});

// ── what a machine wants from the reader ───────────────────────────────────

// Every per-device switch granted, so a case about the agent is not also a case about permissions.
const GRANTED = { sandboxes: `on`, sandboxRemove: `on` };

const concernsOf = (overrides: Partial<Device> = {}, held: Partial<Report> = {}, latest?: string, scopes?: Record<string, string>) => {
    const entry = row(overrides, held, latest);
    return deviceAttention(entry, { block: manageBlock(entry.device, scopes), latest, now: NOW });
};

test(`says nothing at all about a healthy, fully-permitted machine`, () => {
    expect(concernsOf({}, {}, undefined, GRANTED)).toEqual([]);
});

test(`leads with whether the machine answers, then how old the reading is`, () => {
    const concerns = concernsOf({ gap: `no-agent` }, { capturedAt: NOW - 61_000 });
    expect(concerns.map((concern) => concern.key)).toEqual([`gap`, `stale`]);
    expect(concerns[0]?.text).toContain(`it has no agent`);
    expect(concerns[1]?.text).toContain(`What follows is what it looked like then.`);
});

test(`asks for one restart, naming the worst reason, rather than one sentence per symptom`, () => {
    const concerns = concernsOf({}, { agent: { running: false, build: `1.1.0`, installed: `1.2.0` } });
    const restarts = concerns.filter((concern) => concern.key === `agent-restart`);
    expect(restarts).toHaveLength(1);
    expect(restarts[0]?.text).toContain(`isn't running`);
    expect(restarts[0]?.fix).toMatchObject({ kind: `agent`, op: `restart`, label: `Restart agent` });
});

test(`asks for a restart, not a download, when only the loop is behind the installed build`, () => {
    const concerns = concernsOf({}, { agent: { running: true, lastTickAt: NOW, build: `1.1.0`, installed: `1.2.0` } }, `1.2.0`, GRANTED);
    expect(concerns.map((concern) => concern.key)).toEqual([`agent-restart`]);
    expect(concerns[0]?.text).toContain(`serving agent 1.1.0 while 1.2.0 is installed here`);
});

test(`offers the update when something newer than the installed build has been published`, () => {
    const concerns = concernsOf({}, { agent: { running: true, lastTickAt: NOW, build: `1.1.0`, installed: `1.1.0` } }, `1.2.0`, GRANTED);
    expect(concerns.map((concern) => concern.key)).toEqual([`agent-update`]);
    expect(concerns[0]?.text).toBe(`Agent 1.2.0 has been published; this device has 1.1.0.`);
    expect(concerns[0]?.fix).toMatchObject({ kind: `agent`, op: `upgrade` });
});

test(`makes no claim about the agent when this sandbox doesn't know the latest release`, () => {
    const concerns = concernsOf({}, { agent: { running: true, lastTickAt: NOW, build: `1.1.0`, installed: `1.1.0` } }, undefined);
    expect(concerns.filter((concern) => concern.key === `agent-update`)).toEqual([]);
});

test(`keeps the sentence and drops the button on a machine no button could reach`, () => {
    const concerns = concernsOf({ online: false }, { agent: { running: false } });
    const restart = concerns.find((concern) => concern.key === `agent-restart`);
    expect(restart?.text).toContain(`isn't running`);
    expect(restart?.fix).toBeUndefined();
});

test(`names the switch a connected machine is missing, and where to flip it`, () => {
    const concerns = concernsOf({ platform: `linux` }, {}, undefined, { platform: `linux` });
    const block = concerns.find((concern) => concern.key === `block`);
    expect(block?.text).toContain(`Manage sandboxes on this device`);
    expect(block?.fix).toMatchObject({ kind: `card`, card: `linux`, connection: `host-rog`, label: `Open its permissions` });
});

test(`names the command, not a card, where the fix is a command on that machine`, () => {
    const concerns = concernsOf({ online: false, platform: `linux` }, {}, undefined, { platform: `linux` });
    const block = concerns.find((concern) => concern.key === `block`);
    expect(block?.command).toBe(`intentic-machine run`);
    expect(block?.fix).toBeUndefined();
});

test(`explains the gap without a button when there is no card to connect the machine`, () => {
    const concerns = concernsOf({ hostId: undefined, platform: `macos` });
    const block = concerns.find((concern) => concern.key === `block`);
    expect(block?.text).toContain(`Connect it as a device`);
    expect(block?.fix).toBeUndefined();
});

test(`agrees with isSelf about which group is the one you're using`, () => {
    const entry = row({}, PAIRED);
    const [group] = entry.groups;
    expect(group).toMatchObject({ sandboxId: `work-abc` });
    expect(isSelf(entry.device, group!, `work-abc`)).toBe(true);
    expect(isSelf(entry.device, group!, `other`)).toBe(false);
});

// ── the two addresses ──────────────────────────────────────────────────────

test(`addresses a machine by its key on the Devices tab, and the board by dropping it`, () => {
    expect(deviceRoute(`rog`)).toEqual({ name: `sandbox`, params: { tab: `devices` }, query: { device: `rog` } });
    // An empty query, not an absent one: the board must actively clear a `device=` already in the URL.
    expect(boardRoute()).toEqual({ name: `sandbox`, params: { tab: `devices` }, query: {} });
});

test(`names no machine for a missing, empty or repeated param`, () => {
    expect(selectedKey(`rog`)).toBe(`rog`);
    expect(selectedKey(undefined)).toBeUndefined();
    expect(selectedKey(``)).toBeUndefined();
    expect(selectedKey(null)).toBeUndefined();
    // `?device=a&device=b` names no single machine, so it selects none rather than the first.
    expect(selectedKey([`a`, `b`])).toBeUndefined();
});
