import type { Device } from "@intentic/sandbox-contract";
import {
    agentBehind,
    agentChip,
    agentHalted,
    deviceDoors,
    deviceQuiet,
    deviceReconnecting,
    hostEntry,
    lastSeenNote,
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

// The row's loudest fact has to carry this: a distro and the Windows install hosting it arrive under one hostname,
// so without it the board shows what reads as the same machine listed twice.
const wsl = (distro: string): NonNullable<Device[`report`]> => ({
    hostname: `radarsu-rog`,
    os: `linux`,
    wsl: { distro },
    pairings: [],
    ports: [],
    agent: { running: true, installed: `1.252.0` },
    capturedAt: NOW,
});

test(`says a machine is WSL, since that is all that separates it from the Windows row beside it`, () => {
    expect(osLabel(device({ platform: `linux`, report: wsl(`Arch`) }))).toBe(`Arch on WSL`);
    // Described by its own capability card as well: the distro's name for itself leads, WSL qualifies it.
    const connected = device({ hostId: `rog-wsl`, platform: `linux`, facts: { ...WINDOWS, os: `Arch Linux` }, report: wsl(`Arch`) });
    expect(osLabel(connected)).toBe(`Arch Linux on WSL`);
    // The suffix is not something the machine said, so it must not turn into a tooltip promising more.
    expect(osTitle(connected)).toBeUndefined();
});

test(`marks a distro that would not name itself`, () => {
    expect(osLabel(device({ report: wsl(``) }))).toBe(`WSL`);
    // The bare platform is the last resort: every distro on the machine would answer it with the same word.
    expect(osLabel(device({ platform: `linux`, report: wsl(``) }))).toBe(`Linux on WSL`);
});

// Hub liveness resets when the daemon restarts, so a side of a PC that has not dialled in since holds no facts and no
// report — and two sleeping distros of one machine both reading "Linux" is the row telling the reader nothing.
test(`names a sleeping distro after the door it connected through`, () => {
    const sleeping = device({ hostId: `radarsu-omen::wsl:Ubuntu-22.04`, platform: `linux`, online: false, gap: `offline` });
    expect(osLabel(sleeping)).toBe(`Ubuntu-22.04 on WSL`);
    // The native side of that same card is the machine itself, and says so.
    expect(osLabel(device({ hostId: `radarsu-omen`, platform: `windows`, online: false, gap: `offline` }))).toBe(`Windows`);
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
            pairings: [],
            ports: [],
            agent: { running: true, build: `0.5.1`, installed: `0.5.1` },
            capturedAt: 1_700_000_000_000,
        },
    });
    expect(deviceDoors(row)).toEqual([{ name: `desktop sync` }, { name: `commands` }]);
    expect(agentChip(row)).toEqual({ version: `0.5.1` });
});

const reportWith = (agent: NonNullable<Device[`report`]>[`agent`]): Device[`report`] => ({
    hostname: `MY-PC`,
    os: `linux`,
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

test(`names the doors this sandbox holds, and what each half of desktop sync is called`, () => {
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

// The window that keeps an agent restart from reading as a machine that went away. Everything it exempts is a
// machine with no socket right now; the two guards below are the cases that look alike and are not.
test(`reads a freshly dropped socket as reconnecting, and only that`, () => {
    const dropped = { hostId: `my-pc`, online: false, gap: `offline`, lastSeen: NOW - 3_000 } as const;
    expect(deviceReconnecting(device(dropped), NOW)).toBe(true);
    // Held long enough to be a machine that is away, not one mid-restart.
    expect(deviceReconnecting(device({ ...dropped, lastSeen: NOW - 60_000 }), NOW)).toBe(false);
    // A machine holding its socket while refusing to answer is unreachable in a way that waiting never fixes.
    expect(deviceReconnecting(device({ ...dropped, online: true }), NOW)).toBe(false);
    // Never connected: `lastSeen` is the stamp of a link this sandbox actually held, and there is none.
    expect(deviceReconnecting(device({ hostId: `my-pc`, online: false, gap: `offline` }), NOW)).toBe(false);
});

// A machine that has reported: folders, ports and its agent arrived. No container list — the sync door never carries
// one, and this row has no device door to ask through.
const reported = (overrides: Partial<Device> = {}): Device =>
    device({
        sync: enrolled(),
        report: {
            hostname: `laptop`,
            os: `win32`,
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
    expect(hostEntry(`macos`)).toBeUndefined();
    expect(hostEntry(undefined)).toBeUndefined();
});

test(`names the sandbox switch when a connected device has not been granted it`, () => {
    const connected = device({ hostId: `my-pc`, online: true, platform: `windows` });
    expect(manageBlock(connected, { platform: `windows`, shell: `on` })).toEqual({
        kind: `sandboxes-off`,
        connection: `my-pc`,
        card: `windows`,
    });
    // The one switch carries the whole lifecycle, so granting it leaves nothing to explain.
    expect(manageBlock(connected, { platform: `windows`, shell: `on`, sandboxes: `on` })).toBeUndefined();
});

// The card comes from what the connection pinned, not from the row's own platform.
test(`opens the card the connection actually came from`, () => {
    const row = device({ hostId: `my-pc`, online: true, platform: `linux` });
    expect(manageBlock(row, { platform: `windows` })).toEqual({ kind: `sandboxes-off`, connection: `my-pc`, card: `windows` });
});

// An environment of a machine is a connection of that machine's card, and the switches it is admitted on are the
// card's: sending the reader to `rog::wsl:Arch` would open a form for something that has none.
test(`sends a distro's row to its computer's own form`, () => {
    const distro = device({ hostId: `rog::wsl:Arch`, online: true, platform: `linux` });
    expect(manageBlock(distro, { platform: `windows`, shell: `on` })).toEqual({ kind: `sandboxes-off`, connection: `rog`, card: `windows` });
});

test(`stays quiet about permissions on a device that cannot be reached`, () => {
    expect(manageBlock(device({ hostId: `my-pc`, online: false, gap: `offline` }), undefined)).toBeUndefined();
    expect(manageBlock(device({ hostId: `my-pc`, online: true, gap: `scope-off` }), undefined)).toBeUndefined();
});

// "Run commands" alone is enough to read the container list, so a machine can list its sandboxes, describe nothing
// else, and still refuse every button — silence here was a row of buttons with nothing explaining them.
test(`still names the switch on a machine that listed containers without describing itself`, () => {
    const locked = device({
        hostId: `my-pc`,
        online: true,
        platform: `linux`,
        gap: `scope-off`,
        sandboxes: [{ slug: `work`, container: `intentic-sandbox-work`, running: true, image: `img:1` }],
    });
    expect(manageBlock(locked, { platform: `linux`, shell: `on`, sandboxes: `off` })).toEqual({
        kind: `sandboxes-off`,
        connection: `my-pc`,
        card: `linux`,
    });
    // The card setup writes for a new sandbox: management granted, so every button below it works.
    expect(manageBlock(locked, { platform: `linux`, shell: `off`, sandboxes: `on` })).toBeUndefined();
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
    expect(machineWarnings(device({ sync: enrolled(`sync`, NOW), report: watching({ agent: { running: false } }) }), NOW)).toEqual([`agent stopped`]);
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
