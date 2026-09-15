import type { Device } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { deviceAttention } from "./deviceAttention";
import {
    boardBody,
    type DeviceRow,
    deviceRow,
    deviceState,
    deviceSwitches,
    deviceSyncingSandbox,
    deviceTally,
    deviceTone,
    folderOwner,
    isSelf,
    machineRow,
    machineRows,
    managerOf,
    rowMatches,
    showFilter,
} from "./deviceRows";
import { boardRoute, deviceRoute, selectedKey } from "./deviceLinks";
import { manageBlock } from "./deviceFacts";

// The board's and the device page's shared rules, checked without mounting either: which machine reads as
// live, what a card says about it, and what it wants from the reader.

// One instant for every judgement below, so a threshold is crossed on purpose. It stands for when the reading
// landed here (readAt), which is what every freshness rule is measured against.
const NOW = 1_700_000_000_000;

type Report = NonNullable<Device[`report`]>;

// A live loop: `agentStalled` reads `lastTickAt`, so a fixture without one is neither live nor stalled.
const report = (overrides: Partial<Report> = {}): Report => ({
    hostname: `rog`,
    os: `linux`,
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

// What the machine said about itself, across both of its answers: folders and ports from its report, containers from
// the host door's own list, which rides the row because it answers to its own switch.
type Held = Partial<Report> & { sandboxes?: Device[`sandboxes`] };

// Two axes, kept apart: what the daemon says about the machine, and what the machine said about itself.
const row = (overrides: Partial<Device> = {}, held: Held = {}, latest?: string) => {
    const { sandboxes, ...reported } = held;
    return deviceRow(device({ report: report(reported), ...(sandboxes === undefined ? {} : { sandboxes }), ...overrides }), latest);
};

// The board and its tally read machines; a lone device is a machine of one environment, keyed as itself.
const card = (entry: DeviceRow) => machineRow([entry], entry.device);

// which machine reads as live

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

// The verdict is a function of the reading and its arrival, never of the clock: a reading that was fresh when it
// landed stays fresh however long the list is held, and only one that arrives already old reads as quiet.
test(`judges a machine as of the reading's arrival, not as of now`, () => {
    const fresh = device({ report: report({ capturedAt: NOW }) });
    expect(deviceState(fresh, NOW)).toBe(`live`);
    // The same reading handed over an hour after the machine took it: that machine really has gone quiet.
    expect(deviceState(fresh, NOW + 60 * 60_000)).toBe(`gone quiet`);
});

// Both stamps are the machine's own, so the loop is judged on the machine's clock: an old reading of a healthy loop
// is old, not dead, and says so once ("gone quiet") rather than twice.
test(`does not read an old reading of a ticking loop as a dead one`, () => {
    const old = report({ capturedAt: NOW - 19 * 60_000, agent: { running: true, lastTickAt: NOW - 19 * 60_000 - 3_000 } });
    expect(deviceRow(device({ report: old }), undefined).agent?.stalled).toBe(false);
    expect(deviceState(device({ report: old }), NOW)).toBe(`gone quiet`);
});

test(`keeps an asleep machine neutral: offline is a state, not a fault`, () => {
    const asleep = device({ gap: `offline`, online: false, report: undefined });
    expect(deviceState(asleep, NOW)).toBe(`offline`);
    expect(deviceTone(asleep, NOW)).toBe(`neutral`);
});

// `lastSeen` is stamped when the socket drops, so its age is the age of the silence: seconds of it is what
// restarting an agent looks like from here, and calling that offline is a verdict the next reading undoes.
test(`calls a machine whose socket just dropped reconnecting, not offline`, () => {
    const dropped = device({ gap: `offline`, online: false, report: undefined, lastSeen: NOW - 3_000 });
    expect(deviceState(dropped, NOW)).toBe(`reconnecting`);
    // The same colour as offline: only the word is wrong while a machine is coming back, never the rank.
    expect(deviceTone(dropped, NOW)).toBe(`neutral`);
    expect(deviceState({ ...dropped, lastSeen: NOW - 60_000 }, NOW)).toBe(`offline`);
});

test(`puts the machines worth reading first, and breaks ties by name`, () => {
    const rows = machineRows(
        [
            device({ key: `zed`, label: `zed`, gap: `offline`, online: false, report: undefined }),
            device({ key: `beta`, label: `beta` }),
            device({ key: `alpha`, label: `alpha` }),
            device({ key: `dead`, label: `dead`, report: report({ agent: { running: false } }) }),
        ],
        undefined,
        NOW,
    );
    expect(rows.map((entry) => entry.label)).toEqual([`alpha`, `beta`, `dead`, `zed`]);
});

// one PC, several doors

// The Windows side and the distro on it: separate agents and separate doors, one hostname, one engine.
const WINDOWS: Device[`facts`] = { os: `Microsoft Windows 11 Home`, arch: `x64`, shell: `PowerShell 7`, home: `C:\\Users\\radar`, roots: [], hostname: `rog`, wslDistros: [`Arch`, `Ubuntu`] };
const ARCH: Device[`facts`] = { os: `Arch Linux`, arch: `x64`, shell: `/usr/bin/zsh`, home: `/home/radarsu`, roots: [], hostname: `rog`, wsl: { distro: `Arch` } };

const CONTAINERS: Device[`sandboxes`] = [{ slug: `work-abc`, container: `sandbox-work-abc`, running: true, image: `img:1` }];

const pc = () =>
    machineRows(
        [
            device({ key: `rog-wsl`, label: `rog-wsl`, hostId: `rog-wsl`, facts: ARCH, sandboxes: CONTAINERS, report: report({ os: `linux`, wsl: { distro: `Arch` }, pairings: PAIRED.pairings, ports: PAIRED.ports }) }),
            device({ key: `rog`, label: `rog`, hostId: `rog`, facts: WINDOWS, sandboxes: CONTAINERS, report: report({ os: `win32` }) }),
        ],
        undefined,
        NOW,
    );

test(`folds a Windows install and its distro into one machine, Windows first, with each container once`, () => {
    const [machine, ...rest] = pc();
    expect(rest).toEqual([]);
    expect(machine).toMatchObject({ key: `rog`, label: `rog` });
    expect(machine?.environments.map((environment) => environment.device.key)).toEqual([`rog`, `rog-wsl`]);
    // Both doors list the same engine's container; the folder and ports came from the distro's report.
    expect(machine?.groups.map((group) => group.sandboxId)).toEqual([`work-abc`]);
    expect(machine?.groups[0]?.folder?.localDir).toBe(`/home/ada/work`);
    expect(machine?.groups[0]?.ports).toHaveLength(1);
    expect(deviceTally(pc()).find((item) => item.label === `running`)?.value).toBe(1);
});

test(`draws a many-sided machine's environments as lines of their own, and names the side a warning is about`, () => {
    const body = boardBody(pc()[0]!, ``, `work-abc`, NOW);
    expect(body.doors).toEqual([]);
    expect(body.environments.map((environment) => environment.label)).toEqual([`Microsoft Windows 11 Home`, `Arch Linux on WSL`]);
    expect(body.environments.map((environment) => environment.state)).toEqual([`live`, `live`]);
    // Either door onto the container serving this page marks the machine as the one in use.
    expect(body.lines[0]?.self).toBe(true);
    const stopped = machineRows(
        [device({ key: `rog-wsl`, hostId: `rog-wsl`, facts: ARCH, report: report({ os: `linux`, wsl: { distro: `Arch` }, agent: { running: false } }) }), device({ key: `rog`, hostId: `rog`, facts: WINDOWS, report: report({ os: `win32` }) })],
        undefined,
        NOW,
    );
    expect(boardBody(stopped[0]!, ``, undefined, NOW).warnings).toEqual([`Arch Linux on WSL: agent stopped`]);
});

test(`sends container verbs through the first open door and file-sync verbs through the folder's own`, () => {
    const machine = pc()[0]!;
    expect(managerOf(machine)?.device.key).toBe(`rog`);
    expect(folderOwner(machine, machine.groups[0]!)?.device.key).toBe(`rog-wsl`);
    // A door that is shut is not the one to send through, whichever side it is on.
    const asleep = machineRows(
        [device({ key: `rog-wsl`, hostId: `rog-wsl`, facts: ARCH, report: report({ os: `linux`, wsl: { distro: `Arch` } }) }), device({ key: `rog`, hostId: `rog`, online: false, facts: WINDOWS, gap: `offline`, report: undefined })],
        undefined,
        NOW,
    );
    expect(managerOf(asleep[0]!)?.device.key).toBe(`rog-wsl`);
});

test(`finds a many-sided machine by either of its doors`, () => {
    const machine = pc()[0]!;
    expect(rowMatches(machine, `rog-wsl`)).toBe(true);
    expect(rowMatches(machine, `arch`)).toBe(true);
    expect(rowMatches(machine, `8788`)).toBe(true);
});

// what a card says without being expanded

const PAIRED: Held = {
    pairings: [{ sandboxId: `work-abc`, mode: `sync`, localDir: `/home/ada/work`, mutagenStatus: `watching` }],
    ports: [{ port: 8788, host: `127.0.0.1`, sandboxId: `work-abc`, state: `mirrored`, command: `node vite.js` }],
    sandboxes: [{ slug: `work-abc`, container: `sandbox-work-abc`, name: `intentic-dev`, running: true, image: `img:1` }],
};

// Names a sandbox with nothing but a folder, so a card can be given any number of them.
const folders = (...ids: string[]): Held => ({
    pairings: ids.map((id) => ({ sandboxId: id, mode: `sync` as const, localDir: `/w/${id}` })),
});

test(`names every sandbox the machine holds, and what its ports came to`, () => {
    const body = boardBody(card(row({}, PAIRED)), ``, undefined, NOW);
    expect(body.lines.map((line) => line.title)).toEqual([`intentic-dev`]);
    expect(body.lines[0]?.running).toBe(true);
    expect(body.lines[0]?.facts).toContain(`1 port`);
    expect(body.more).toBe(0);
});

test(`says how the sandbox reaches the machine, and which build its agent serves`, () => {
    const body = boardBody(card(row({ sync: { machine: `rog`, mode: `sync`, seenAt: NOW }, agentVersion: `1.2.0` }, PAIRED)), ``, undefined, NOW);
    expect(body.doors).toEqual([`desktop sync`, `commands`, `agent 1.2.0`]);
});

test(`caps the lines it draws and counts what it left out`, () => {
    const body = boardBody(card(row({}, folders(`a`, `b`, `c`, `d`, `e`))), ``, undefined, NOW);
    expect(body.lines).toHaveLength(3);
    expect(body.more).toBe(2);
});

test(`draws every match while the filter is set, so a port search never lands off the list`, () => {
    const held: Held = { ...folders(`a`, `b`, `c`, `d`), ports: [{ port: 8788, host: `127.0.0.1`, sandboxId: `d`, state: `mirrored` }] };
    const body = boardBody(card(row({}, held)), `8788`, undefined, NOW);
    expect(body.lines.map((line) => line.title)).toEqual([`d`]);
    expect(body.more).toBe(0);
});

// A machine whose card grants sandbox management and nothing else lists its containers and refuses to describe
// itself. Grouping off the report dropped those rows entirely, which is what left a freshly added sandbox reading a
// terminal command for the one rebuild it always needs.
test(`draws the containers of a machine that would not describe itself`, () => {
    const locked = deviceRow(device({ gap: `scope-off`, report: undefined, sandboxes: PAIRED.sandboxes }), undefined);
    expect(locked.groups.map((group) => group.sandbox?.slug)).toEqual([`work-abc`]);
    // No report, so nothing under the row: its folder and its ports are exactly what the shut switch withholds.
    expect(locked.groups[0]?.folder).toBeUndefined();
    expect(locked.groups[0]?.ports).toEqual([]);
});

test(`separates what is wrong with the machine from what is wrong with its sandboxes`, () => {
    const body = boardBody(card(row({}, { ...PAIRED, agent: { running: false } })), ``, undefined, NOW);
    expect(body.warnings).toEqual([`agent stopped`]);
    expect(body.lines[0]?.warnings).toEqual([]);
});

test(`marks the sandbox serving this page, and only when both slugs are known`, () => {
    expect(boardBody(card(row({}, PAIRED)), ``, `work-abc`, NOW).lines[0]?.self).toBe(true);
    // Two unknowns must not compare equal: a pairing with no container on an unknown-URL sandbox is not "you".
    const bare: Partial<Report> = { pairings: PAIRED.pairings };
    expect(boardBody(card(row({}, bare)), ``, undefined, NOW).lines[0]?.self).toBe(false);
});

test(`finds a machine by a port number, by its sandbox, and by its folder`, () => {
    const entry = card(row({}, PAIRED));
    expect(rowMatches(entry, `8788`)).toBe(true);
    expect(rowMatches(entry, `intentic-dev`)).toBe(true);
    expect(rowMatches(entry, `/home/ada`)).toBe(true);
    expect(rowMatches(entry, `nothing-here`)).toBe(false);
});

test(`offers no filter over a board small enough to read`, () => {
    expect(showFilter([card(row())])).toBe(false);
    expect(showFilter([card(row()), card(row()), card(row())])).toBe(true);
    // Or over one machine holding more sandboxes than a reader can hold in their head.
    expect(showFilter([card(row({}, folders(`a`, `b`, `c`, `d`)))])).toBe(true);
});

test(`counts the fleet's sandboxes by state, and keeps "running" visible at zero`, () => {
    const stopped: Held = {
        ...PAIRED,
        sandboxes: [{ slug: `work-abc`, container: `sandbox-work-abc`, running: false, image: `img:1` }],
    };
    const tally = deviceTally([card(row({}, PAIRED)), card(row({ key: `omen`, label: `omen` }, stopped))]);
    expect(tally.find((item) => item.label === `running`)?.value).toBe(1);
    expect(tally.find((item) => item.label === `running`)?.always).toBe(true);
    expect(tally.find((item) => item.label === `stopped`)?.value).toBe(1);
});

// the machine-wide switches

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

// what a machine wants from the reader

// Every per-device switch granted, so a case about the agent is not also a case about permissions.
const GRANTED = { sandboxes: `on`, sandboxRemove: `on` };

// `canPair` is the reader's own standing (owner, by default here): the daemon refuses a member's mint, so it
// decides whether a machine that isn't answering is offered a fresh pairing at all.
const concernsOf = (
    overrides: Partial<Device> = {},
    held: Held = {},
    latest?: string,
    scopes?: Record<string, string>,
    canPair = true,
) => {
    const entry = row(overrides, held, latest);
    return deviceAttention(entry, { block: manageBlock(entry.device, scopes), readAt: NOW, canPair });
};

test(`says nothing at all about a healthy, fully-permitted machine`, () => {
    expect(concernsOf({}, {}, undefined, GRANTED)).toEqual([]);
});

test(`leads with whether the machine answers, then how old the reading is`, () => {
    // Granted, like every case here that isn't about permissions: an ungranted switch is a third concern of its own.
    const concerns = concernsOf({ gap: `no-agent` }, { capturedAt: NOW - 61_000 }, undefined, GRANTED);
    expect(concerns.map((concern) => concern.key)).toEqual([`gap`, `stale`]);
    expect(concerns[0]?.text).toContain(`it has no agent`);
    expect(concerns[1]?.text).toContain(`What follows is what it looked like then.`);
});

// The agent is an object with a home of its own now (deviceAgent.ts), so nothing about its state, its build
// or its two verbs may reappear here: a sentence in this strip and controls further down the page is the
// split that sent people to the machine to type `intentic-machine upgrade`.
test(`says nothing about the agent itself, whatever state it is in`, () => {
    const dead = concernsOf({}, { agent: { running: false, build: `1.1.0`, installed: `1.2.0` } }, `1.3.0`, GRANTED);
    expect(dead).toEqual([]);
    const stale = concernsOf({}, { agent: { running: true, lastTickAt: NOW, build: `1.1.0`, installed: `1.2.0` } }, `1.2.0`, GRANTED);
    expect(stale).toEqual([]);
});

test(`names the switch a connected machine is missing, and where to flip it`, () => {
    const concerns = concernsOf({ platform: `linux` }, {}, undefined, { platform: `linux` });
    const block = concerns.find((concern) => concern.key === `block`);
    expect(block?.text).toContain(`Manage sandboxes on this device`);
    expect(block?.fix).toMatchObject({ kind: `card`, card: `linux`, connection: `host-rog`, label: `Open its permissions` });
});

// A held report means the machine's own words survive a shut door, so the silence is explained by the block
// rather than by a gap; both ways back are named all the same.
test(`names the command, not a card, where the fix is a command on that machine`, () => {
    const concerns = concernsOf({ online: false, platform: `linux` }, {}, undefined, { platform: `linux` });
    const block = concerns.find((concern) => concern.key === `block`);
    expect(block?.command).toBe(`intentic-machine run`);
    expect(block?.fix).toMatchObject({ kind: `connect`, label: `Reconnect` });
});

test(`offers a machine that stopped answering a fresh pairing, since nothing else here can reach it`, () => {
    const concerns = concernsOf({ online: false, report: undefined, gap: `offline` });
    const gap = concerns.find((concern) => concern.key === `gap`);
    expect(gap?.text).toContain(`Asleep or offline.`);
    // The cheaper of the two, for a machine that is awake with only its loop down.
    expect(gap?.command).toBe(`intentic-machine run`);
    expect(gap?.fix).toMatchObject({ kind: `connect`, label: `Reconnect` });
});

// The flicker this window exists for: unpairing a sandbox, updating an agent and restarting one all end the
// socket this page is read over, and the strip would open a slab of remedies for a machine already dialling back.
test(`says nothing at all while a machine that dropped seconds ago is coming back`, () => {
    expect(concernsOf({ online: false, report: undefined, gap: `offline`, lastSeen: NOW - 3_000 })).toEqual([]);
    // Past the window the machine really is away, and every remedy is offered again.
    const away = concernsOf({ online: false, report: undefined, gap: `offline`, lastSeen: NOW - 60_000 });
    expect(away.map((concern) => concern.key)).toEqual([`gap`]);
    expect(away[0]?.text).toContain(`Asleep or offline.`);
});

test(`keeps the sentence and drops the pairing for a reader the daemon would refuse`, () => {
    const concerns = concernsOf({ online: false, report: undefined, gap: `offline` }, {}, undefined, undefined, false);
    const gap = concerns.find((concern) => concern.key === `gap`);
    expect(gap?.command).toBe(`intentic-machine run`);
    expect(gap?.fix).toBeUndefined();
});

// Desktop sync enrolls a folder, not a device: there is no host capability to re-pair, so re-enrolling one is
// the Add-a-device flow's job, not this sentence's.
test(`offers no pairing to a machine this sandbox reaches only through desktop sync`, () => {
    const concerns = concernsOf({ hostId: undefined, online: undefined, report: undefined, gap: `unreported` });
    expect(concerns.find((concern) => concern.key === `gap`)?.fix).toBeUndefined();
});

// Every other gap is a machine that does answer: its own sentence names the switch or the install that closes
// it, and a second button offering a pairing beside that would point at the wrong errand.
test(`keeps both ways back for the one gap that is silence`, () => {
    const remedies = ([`offline`, `scope-off`, `no-agent`, `unreported`] as const).map((gap) => {
        const concern = concernsOf({ gap, report: undefined }).find((entry) => entry.key === `gap`);
        return [gap, concern?.command, concern?.fix?.kind];
    });
    expect(remedies).toEqual([
        [`offline`, `intentic-machine run`, `connect`],
        [`scope-off`, undefined, undefined],
        [`no-agent`, undefined, undefined],
        [`unreported`, undefined, undefined],
    ]);
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

// the machine worth offering to connect
// What the screens that print a command need to know: a machine is already talking to this sandbox, and one card
// away from being able to run that command for the reader.

// A sync pairing keys this sandbox the way the agent does, by the flattened host, not by docker's shorter slug.
const pairedTo = (sandboxId: string, mode: `sync` | `mirror` = `sync`): Report =>
    report({ pairings: [{ sandboxId, mode, localDir: `/home/ada/work` }] });

test(`names the machine holding this sandbox's sync pairing`, () => {
    const syncing = device({ hostId: undefined, online: undefined, report: pairedTo(`sandbox-82789f4106b4-fra`) });
    expect(deviceSyncingSandbox([syncing], `sandbox-82789f4106b4`)?.label).toBe(`rog`);
    // Exactly, too: a pairing that already matches docker's spelling is the same machine.
    expect(deviceSyncingSandbox([device({ hostId: undefined, report: pairedTo(`work-abc`) })], `work-abc`)?.label).toBe(`rog`);
});

test(`names nobody when the pairing belongs to a different sandbox`, () => {
    const other = device({ hostId: undefined, report: pairedTo(`sandbox-999999999999-fra`) });
    expect(deviceSyncingSandbox([other], `sandbox-82789f4106b4`)).toBeUndefined();
    // A prefix that isn't a whole label is a different sandbox, not this one.
    expect(deviceSyncingSandbox([device({ hostId: undefined, report: pairedTo(`work-abcdef`) })], `work-abc`)).toBeUndefined();
});

// Mirroring is ports only: that machine holds none of this sandbox's files and is not where it runs.
test(`ignores a machine that only mirrors the ports`, () => {
    const mirroring = device({ hostId: undefined, report: pairedTo(`work-abc`, `mirror`) });
    expect(deviceSyncingSandbox([mirroring], `work-abc`)).toBeUndefined();
});

// Already connected: hostRunningSandbox is the question to ask about it, and offering to connect it again says
// nothing true.
test(`ignores a machine that is already a connected device`, () => {
    expect(deviceSyncingSandbox([device({ report: pairedTo(`work-abc`) })], `work-abc`)).toBeUndefined();
});

test(`names nobody without a slug to match against`, () => {
    const syncing = device({ hostId: undefined, report: pairedTo(`work-abc`) });
    expect(deviceSyncingSandbox([syncing], undefined)).toBeUndefined();
    expect(deviceSyncingSandbox([syncing], ``)).toBeUndefined();
});

// the two addresses

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
