import type { Device } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import {
    agentBehind,
    agentChip,
    agentHalted,
    deviceDoors,
    deviceQuiet,
    hostCard,
    lastSeenNote,
    deviceHardware,
    machineWarnings,
    manageBlock,
    osLabel,
    osTitle,
    syncNote,
    syncStopped,
} from "./deviceFacts";

// One instant for every judgement below, so a threshold is crossed on purpose. It stands for when the reading landed
// here (readAt), which every rule about age is measured against.
const NOW = 1_700_000_000_000;

// Covers the two arrival doors, including rows with no report at all (no sync agent installed, or asleep).
const device = (overrides: Partial<Device> = {}): Device => ({
    key: `my-pc`,
    label: `my-pc`,
    ...overrides,
});

// One desktop-sync enrollment: which half the device holds, and when it last checked in.
const enrolled = (mode: `sync` | `mirror` = `sync`, seenAt?: number): Device[`sync`] => ({
    machine: `my-pc`,
    mode,
    ...(seenAt === undefined ? {} : { seenAt }),
});

const WINDOWS = {
    os: `Windows 11 Pro (build 10.0.26100)`,
    arch: `x64`,
    shell: `PowerShell 7`,
    home: `C:\\Users\\ada`,
    roots: [`C:\\Users\\ada`],
};

test(`shows the machine's own name for its OS, with the build behind a tooltip`, () => {
    const row = device({ hostId: `my-pc`, online: true, platform: `windows`, facts: WINDOWS });
    expect(osLabel(row)).toBe(`Windows 11 Pro`);
    expect(osTitle(row)).toBe(`Windows 11 Pro (build 10.0.26100)`);
});

test(`falls back to the platform when the machine has never described itself`, () => {
    expect(osLabel(device({ platform: `windows` }))).toBe(`Windows`);
    expect(osLabel(device({ platform: `linux` }))).toBe(`Linux`);
    expect(osLabel(device({ platform: `macos` }))).toBe(`macOS`);
    // An unknown platform is still shown as the raw string; nothing to say is the only case that shows nothing.
    expect(osLabel(device({ platform: `freebsd` }))).toBe(`freebsd`);
    expect(osLabel(device())).toBeUndefined();
    expect(osTitle(device({ platform: `windows` }))).toBeUndefined();
});

test(`separates what the device is, how it is reached, and which agent it runs`, () => {
    const row = device({
        label: `laptop`,
        sync: enrolled(),
        hostId: `my-pc`,
        online: true,
        platform: `windows`,
        facts: WINDOWS,
        agentVersion: `0.5.1`,
        report: {
            hostname: `ADA-LAPTOP`,
            os: `win32`,
            sandboxes: [],
            pairings: [],
            ports: [],
            agent: { running: true, build: `0.5.1`, installed: `0.5.1` },
            capturedAt: 1_700_000_000_000,
        },
    });
    expect(deviceHardware(row)).toEqual([`x64`, `PowerShell 7`, `ADA-LAPTOP`]);
    expect(deviceDoors(row)).toEqual([{ name: `desktop sync` }, { name: `commands` }]);
    expect(agentChip(row)).toEqual({ version: `0.5.1` });
});

const reportWith = (agent: NonNullable<Device[`report`]>[`agent`]): Device[`report`] => ({
    hostname: `MY-PC`,
    os: `linux`,
    sandboxes: [],
    pairings: [],
    ports: [],
    agent,
    capturedAt: NOW,
});

// Installed earns a word only when it differs from serving: an errand (restart), not a second version.
test(`the agent chip shows the build serving, and names the installed one only when it differs`, () => {
    const current = device({ report: reportWith({ running: true, build: `1.243.0`, installed: `1.243.0` }) });
    expect(agentChip(current)).toEqual({ version: `1.243.0` });

    const skewed = device({ report: reportWith({ running: true, build: `1.233.0`, installed: `1.243.0` }) });
    expect(agentChip(skewed)).toEqual({ version: `1.233.0`, installed: `1.243.0` });
});

test(`the agent chip does not need a sync enrollment`, () => {
    const row = device({ hostId: `my-pc`, online: true, report: reportWith({ running: true, build: `1.243.0`, installed: `1.243.0` }) });
    expect(row.sync).toBeUndefined();
    expect(agentChip(row)?.version).toBe(`1.243.0`);
});

// The hello frame's version is all a device with no agent, or "Run commands" off, can offer.
test(`the agent chip falls back to what the socket announced`, () => {
    expect(agentChip(device({ hostId: `my-pc`, agentVersion: `1.240.0`, gap: `scope-off` }))).toEqual({ version: `1.240.0` });
    expect(agentChip(device())).toBeUndefined();
});

// Staleness is judged on the installed file, not the running loop: a device serving old code with a current
// file needs a restart, not a download.
test(`only a device whose installed build is behind is offered an update`, () => {
    const behindOnDisk = device({ report: reportWith({ running: true, build: `1.240.0`, installed: `1.240.0` }) });
    expect(agentChip(behindOnDisk, `1.243.0`)).toEqual({ version: `1.240.0`, available: `1.243.0` });
    expect(agentBehind(behindOnDisk, `1.243.0`)).toBe(true);

    const currentOnDisk = device({ report: reportWith({ running: true, build: `1.233.0`, installed: `1.243.0` }) });
    expect(agentChip(currentOnDisk, `1.243.0`)).toEqual({ version: `1.233.0`, installed: `1.243.0` });
    expect(agentBehind(currentOnDisk, `1.243.0`)).toBe(false);
});

test(`a working-tree agent is never called behind`, () => {
    const dev = device({ report: reportWith({ running: true, build: `0.0.0`, installed: `0.0.0` }) });
    expect(agentChip(dev, `1.243.0`)).toEqual({ version: `0.0.0` });
    expect(agentBehind(dev, `1.243.0`)).toBe(false);
});

test(`repeats the hostname only when the row is called something else`, () => {
    const report = reportWith({ running: true });
    expect(deviceHardware(device({ sync: enrolled(), report }))).toEqual([]);
    expect(deviceHardware(device({ label: `ada's box`, sync: enrolled(), report }))).toEqual([`MY-PC`]);
    expect(deviceDoors(device({ sync: enrolled() }))).toEqual([{ name: `desktop sync` }]);
    // A mirror-only device must say "ports only", never "desktop sync" — it syncs no files.
    expect(deviceDoors(device({ sync: enrolled(`mirror`) }))).toEqual([{ name: `ports only` }]);
});

// timeAgo floors rather than rounds, so "1h ago" never claims more time passed than has.
test(`ages a machine that is not here, and stays quiet about one that is`, () => {
    const lastSeen = Date.now() - 90 * 60_000;
    expect(lastSeenNote(device({ hostId: `my-pc`, online: false, lastSeen }))).toBe(`last seen 1h ago`);
    expect(lastSeenNote(device({ hostId: `my-pc`, online: true, lastSeen }))).toBeUndefined();
});

// A machine that has reported: folders and ports arrived, but the container list is empty.
const reported = (overrides: Partial<Device> = {}): Device =>
    device({
        sync: enrolled(),
        report: {
            hostname: `laptop`,
            os: `win32`,
            sandboxes: [],
            pairings: [],
            ports: [],
            agent: { running: true, installed: `1.183.0` },
            capturedAt: 1_700_000_000_000,
        },
        ...overrides,
    });

test(`says a sync-only device must be connected before its sandboxes can be managed`, () => {
    expect(manageBlock(reported({ platform: `windows` }), undefined)).toEqual({ kind: `connect`, card: `windows` });
    expect(manageBlock(reported({ platform: `linux` }), undefined)).toEqual({ kind: `connect`, card: `linux` });
});

test(`stays quiet on a machine that has not reported anything yet`, () => {
    expect(manageBlock(device({ sync: enrolled(), platform: `windows`, gap: `unreported` }), undefined)).toBeUndefined();
});

test(`offers no card for a device this build cannot connect`, () => {
    expect(manageBlock(reported({ platform: `macos` }), undefined)).toEqual({ kind: `connect` });
    expect(manageBlock(reported(), undefined)).toEqual({ kind: `connect` });
    expect(hostCard(`macos`)).toBeUndefined();
    expect(hostCard(undefined)).toBeUndefined();
});

test(`names the sandbox switch when a connected device has not been granted it`, () => {
    const connected = device({ hostId: `my-pc`, online: true, platform: `windows` });
    expect(manageBlock(connected, { platform: `windows`, shell: `on` })).toEqual({
        kind: `sandboxes-off`,
        connection: `my-pc`,
        card: `windows`,
    });
    // Removal has its own grant, since nothing undoes it.
    expect(manageBlock(connected, { platform: `windows`, shell: `on`, sandboxes: `on` })).toEqual({
        kind: `remove-off`,
        connection: `my-pc`,
        card: `windows`,
    });
    expect(manageBlock(connected, { platform: `windows`, shell: `on`, sandboxes: `on`, sandboxRemove: `on` })).toBeUndefined();
});

// The card comes from what the connection pinned, not from the row's own platform.
test(`opens the card the connection actually came from`, () => {
    const row = device({ hostId: `my-pc`, online: true, platform: `linux` });
    expect(manageBlock(row, { platform: `windows` })).toEqual({ kind: `sandboxes-off`, connection: `my-pc`, card: `windows` });
});

test(`stays quiet about permissions on a device that cannot be reached`, () => {
    expect(manageBlock(device({ hostId: `my-pc`, online: false, gap: `offline` }), undefined)).toBeUndefined();
    expect(manageBlock(device({ hostId: `my-pc`, online: true, gap: `scope-off` }), undefined)).toBeUndefined();
    expect(manageBlock(device({ hostId: `my-pc`, online: true, gap: `no-agent` }), undefined)).toBeUndefined();
});

// The device door can be shut while the sync door stays open (files syncing fine, sandbox socket down):
// `online` was never surfaced before this.
test(`says why a connected device that is asleep has no buttons`, () => {
    expect(manageBlock(reported({ hostId: `my-pc`, online: false, platform: `linux` }), { platform: `linux`, sandboxes: `on` })).toEqual({
        kind: `offline`,
        connection: `my-pc`,
        card: `linux`,
    });
    // Suppressed when the row's own `gap: offline` already says so, to avoid the same sentence twice.
    expect(manageBlock(device({ hostId: `my-pc`, online: false, gap: `offline` }), undefined)).toBeUndefined();
});

test(`names which half of desktop sync a device holds`, () => {
    expect(syncNote(device({ sync: enrolled(`sync`, NOW) }), NOW)).toBe(`syncing files and ports`);
    expect(syncNote(device({ sync: enrolled(`mirror`, NOW) }), NOW)).toBe(`mirroring ports`);
    // A connected device that was never paired for sync says nothing at all.
    expect(syncNote(device({ hostId: `my-pc` }), NOW)).toBeUndefined();
});

test(`treats an enrollment that has never been used as stopped`, () => {
    const never = device({ sync: enrolled() });
    expect(syncStopped(never, NOW)).toBe(true);
    expect(syncNote(never, NOW)).toBe(`enrolled for syncing files and ports, never checked in`);
});

// The heartbeat refreshes at most a minute apart, so hours-old means nothing is reaching that folder.
test(`ages an enrollment by its own heartbeat`, () => {
    expect(syncStopped(device({ sync: enrolled(`sync`, NOW - 60_000) }), NOW)).toBe(false);
    const quiet = device({ sync: enrolled(`sync`, NOW - 3 * 60 * 60_000) });
    expect(syncStopped(quiet, NOW)).toBe(true);
    expect(syncNote(quiet, NOW)).toBe(`syncing files and ports: stopped`);
});

// What is wrong with the machine ITSELF: a board card states these under its sandbox lines, which carry
// their own.
const watching = (overrides: Partial<NonNullable<Device[`report`]>> = {}): NonNullable<Device[`report`]> => ({
    hostname: `my-pc`,
    os: `linux`,
    sandboxes: [],
    pairings: [],
    ports: [],
    agent: { running: true },
    capturedAt: NOW,
    ...overrides,
});

test(`says nothing about a machine that is syncing and answering`, () => {
    expect(machineWarnings(device({ sync: enrolled(`sync`, NOW), report: watching() }), NOW)).toEqual([]);
});

test(`warns about a machine whose agent has stopped`, () => {
    expect(machineWarnings(device({ sync: enrolled(`sync`, NOW), report: watching({ agent: { running: false } }) }), NOW)).toEqual([
        `agent stopped`,
    ]);
});

test(`warns about an enrollment that has gone quiet, in the same words it reads when live`, () => {
    expect(machineWarnings(device({ sync: enrolled(`sync`, NOW - 3 * 60 * 60_000), report: watching() }), NOW)).toEqual([
        `syncing files and ports: stopped`,
    ]);
});

test(`counts a machine unheard-from for a minute when the reading landed as quiet, and a fresh one as current`, () => {
    expect(deviceQuiet(device({ report: watching() }), NOW)).toBe(false);
    expect(deviceQuiet(device({ report: watching({ capturedAt: NOW - 61_000 }) }), NOW)).toBe(true);
    // No report is not a quiet machine: the row already says it has never described itself.
    expect(deviceQuiet(device(), NOW)).toBe(false);
});

// The clock is the reading's arrival, so holding a list (a tab left open, a cache restored on load) can never turn a
// machine that was answering into one that has gone quiet.
test(`ages a reading by when it landed, not by how long it has been held`, () => {
    const held = device({ report: watching({ capturedAt: NOW }) });
    expect(deviceQuiet(held, NOW)).toBe(false);
    expect(deviceQuiet(held, NOW + 60 * 60_000)).toBe(true);
});

// Both stamps come off the machine's own clock; comparing the tick against ours made every old reading, and every
// device whose clock is off, read as a dead loop.
test(`judges the agent's rounds on the machine's own clock`, () => {
    const ticking = watching({ capturedAt: NOW - 19 * 60_000, agent: { running: true, lastTickAt: NOW - 19 * 60_000 - 3_000 } });
    expect(agentHalted(device({ report: ticking }))).toBe(false);
    const halted = watching({ agent: { running: true, lastTickAt: NOW - 61_000 } });
    expect(agentHalted(device({ report: halted }))).toBe(true);
    // A stopped loop is a different sentence (`agent stopped`), decided on `running`, not on the tick.
    expect(agentHalted(device({ report: watching({ agent: { running: false, lastTickAt: NOW - 61_000 } }) }))).toBe(false);
});

test(`says nothing about an old reading of a machine that was syncing and answering`, () => {
    const old = { capturedAt: NOW - 19 * 60_000, agent: { running: true, lastTickAt: NOW - 19 * 60_000 } };
    expect(machineWarnings(device({ sync: enrolled(`sync`, NOW), report: watching(old) }), NOW)).toEqual([]);
});
