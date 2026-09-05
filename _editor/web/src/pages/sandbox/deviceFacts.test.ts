import type { Device } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { sandboxGroups } from "@intentic/ui/device";
import {
    agentBehind,
    agentChip,
    deviceDoors,
    deviceSummary,
    hostCard,
    lastSeenNote,
    deviceHardware,
    manageBlock,
    osLabel,
    osTitle,
    syncNote,
    syncStopped,
} from "./deviceFacts";

// One instant for every judgement below, so a threshold is crossed because a test asked for it rather than
// because the suite happened to straddle a minute.
const NOW = 1_700_000_000_000;

/* The row shapes these have to survive are the interesting half. A device arrives through either of two doors,
 * and the ones that arrive with NO report: a connected device whose owner never installed the sync agent, a
 * laptop that is asleep, are exactly the rows this derivation exists for: before it they were a name and a badge,
 * so three of them read as the same device three times. */
const device = (overrides: Partial<Device> = {}): Device => ({
    key: `my-pc`,
    label: `my-pc`,
    ...overrides,
});

// One desktop-sync enrollment on a row: which half this device holds, and when it last checked in. It replaced
// a `syncEnrolled` boolean, which could say a machine was paired and nothing about what that pairing does.
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

// The machine's own words are the good answer, and they arrive with a build number that is longer than the name it
// qualifies, so the row keeps the name and the precise string stays reachable.
test(`shows the machine's own name for its OS, with the build behind a tooltip`, () => {
    const row = device({ hostId: `my-pc`, online: true, platform: `windows`, facts: WINDOWS });
    expect(osLabel(row)).toBe(`Windows 11 Pro`);
    expect(osTitle(row)).toBe(`Windows 11 Pro (build 10.0.26100)`);
});

/* The case the tab shipped without: nothing on the machine has described it, and the row still has to say what
 * kind of device it is. The platform is known from the card it was added with, so this never depends on an agent
 * being installed or the machine being awake. */
test(`falls back to the platform when the machine has never described itself`, () => {
    expect(osLabel(device({ platform: `windows` }))).toBe(`Windows`);
    expect(osLabel(device({ platform: `linux` }))).toBe(`Linux`);
    expect(osLabel(device({ platform: `macos` }))).toBe(`macOS`);
    // A platform this build has never heard of is still shown: the owner knows the word, and a blank row does not
    // become truer by hiding it. Nothing at all to say is the only case that draws nothing.
    expect(osLabel(device({ platform: `freebsd` }))).toBe(`freebsd`);
    expect(osLabel(device())).toBeUndefined();
    expect(osTitle(device({ platform: `windows` }))).toBeUndefined();
});

/* The two questions the row's old single line ran together: what the device IS, and how this sandbox gets to
 * it. They are separated on screen now, so they are derived separately here.
 *
 * AND THE VERSION IS ON NEITHER, which is the fix: it used to ride the door tag, so "desktop sync 1.243.0" put
 * `intentic-machine`'s version under the name of an enrollment mode. Both doors are named here because a row
 * reached through both used to admit only one of them. */
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

/* --- THE AGENT CHIP -------------------------------------------------------------------------------------
 *
 * The chip this replaced read `report.agents.sync` — the file on disk — and wore the ENROLLMENT's name, so one
 * binary's version appeared as "desktop sync 1.243.0" or "ports only 1.243.0" depending on which half the
 * device happened to hold, and on no row that had never been paired for sync at all. */
const reportWith = (agent: NonNullable<Device[`report`]>[`agent`]): Device[`report`] => ({
    hostname: `MY-PC`,
    os: `linux`,
    sandboxes: [],
    pairings: [],
    ports: [],
    agent,
    capturedAt: NOW,
});

// What is SERVING is the version, because that is where the device's behaviour comes from. The file beside it
// earns a word only when it differs, and then it is an errand (restart), not a second number to read.
test(`the agent chip shows the build serving, and names the installed one only when it differs`, () => {
    const current = device({ report: reportWith({ running: true, build: `1.243.0`, installed: `1.243.0` }) });
    expect(agentChip(current)).toEqual({ version: `1.243.0` });

    const skewed = device({ report: reportWith({ running: true, build: `1.233.0`, installed: `1.243.0` }) });
    expect(agentChip(skewed)).toEqual({ version: `1.233.0`, installed: `1.243.0` });
});

/* A DEVICE CONNECTED ONLY FOR COMMANDS STILL HAS AN AGENT, and this is the row the old chip rendered blank: no
 * `sync` enrollment meant no chip, so no version and no update offer, on a machine running the same binary. */
test(`the agent chip does not need a sync enrollment`, () => {
    const row = device({ hostId: `my-pc`, online: true, report: reportWith({ running: true, build: `1.243.0`, installed: `1.243.0` }) });
    expect(row.sync).toBeUndefined();
    expect(agentChip(row)?.version).toBe(`1.243.0`);
});

/* THE ROW WITH NO REPORT AT ALL, which is where the hello frame's version earns its keep: a device whose "Run
 * commands" switch is off, or which has no agent to answer `status --json`, cannot be asked — and it told us
 * what it was when it dialled. Without this the chip goes blank on exactly the rows that need explaining. */
test(`the agent chip falls back to what the socket announced`, () => {
    expect(agentChip(device({ hostId: `my-pc`, agentVersion: `1.240.0`, gap: `scope-off` }))).toEqual({ version: `1.240.0` });
    // And says nothing at all where nothing is known, rather than inventing a version.
    expect(agentChip(device())).toBeUndefined();
});

/* STALENESS IS ASKED OF THE FILE, not of the loop, because that is what an update replaces. A device already
 * holding the current binary and serving an older one is owed a RESTART: offering it a download would send it
 * after bytes it already has, and `upgrade` would answer "already current, nothing to do". */
test(`only a device whose installed build is behind is offered an update`, () => {
    const behindOnDisk = device({ report: reportWith({ running: true, build: `1.240.0`, installed: `1.240.0` }) });
    expect(agentChip(behindOnDisk, `1.243.0`)).toEqual({ version: `1.240.0`, available: `1.243.0` });
    expect(agentBehind(behindOnDisk, `1.243.0`)).toBe(true);

    const currentOnDisk = device({ report: reportWith({ running: true, build: `1.233.0`, installed: `1.243.0` }) });
    expect(agentChip(currentOnDisk, `1.243.0`)).toEqual({ version: `1.233.0`, installed: `1.243.0` });
    expect(agentBehind(currentOnDisk, `1.243.0`)).toBe(false);
});

// A working-tree build is not a version and must never be told it is behind: the same rule isBehind and the
// terminal's own skew check follow, asserted here because this chip is where a nag would appear.
test(`a working-tree agent is never called behind`, () => {
    const dev = device({ report: reportWith({ running: true, build: `0.0.0`, installed: `0.0.0` }) });
    expect(agentChip(dev, `1.243.0`)).toEqual({ version: `0.0.0` });
    expect(agentBehind(dev, `1.243.0`)).toBe(false);
});

// The hostname is worth width only when the row is showing a different name. Machines are routinely enrolled under
// their own hostname, and "my-pc · my-pc" is the kind of line that makes a reader stop reading the rest.
test(`repeats the hostname only when the row is called something else`, () => {
    const report = reportWith({ running: true });
    expect(deviceHardware(device({ sync: enrolled(), report }))).toEqual([]);
    expect(deviceHardware(device({ label: `ada's box`, sync: enrolled(), report }))).toEqual([`MY-PC`]);
    expect(deviceDoors(device({ sync: enrolled() }))).toEqual([{ name: `desktop sync` }]);
    // A ports-only device gets the words that describe it: "desktop sync" over a mirror sends its owner
    // looking for a folder that does not exist.
    expect(deviceDoors(device({ sync: enrolled(`mirror`) }))).toEqual([{ name: `ports only` }]);
});

/* "Last seen" is the one thing an asleep machine can still say, and it is the difference between a lid closed an
 * hour ago and a device nobody has switched on since April, which wear the same grey badge. On a machine that
 * is here right now it is noise the badge already carries.
 *
 * 90 minutes reads "1h ago", not "2h": timeAgo rounds DOWN at every tier, so "1h ago" spans the whole hour after
 * the first and never claims more time has passed than has. It rounded to nearest here until the two age
 * formatters this app had were made one: the other floored, so the same lid closed at the same moment read an
 * hour apart on two screens. */
test(`ages a machine that is not here, and stays quiet about one that is`, () => {
    const lastSeen = Date.now() - 90 * 60_000;
    expect(lastSeenNote(device({ hostId: `my-pc`, online: false, lastSeen }))).toBe(`last seen 1h ago`);
    expect(lastSeenNote(device({ hostId: `my-pc`, online: true, lastSeen }))).toBeUndefined();
});

/* WHY A ROW HAS NO BUTTONS: the derivation the parity complaint is actually about.
 *
 * A machine paired by the desktop app is enrolled for desktop sync alone, and that door never carries containers.
 * So the row rendered folders, ports, and an empty sandbox list with no verbs on it, while the desktop app's own
 * window managed the very same containers on the very same machine. The remedy existed the whole time and was
 * named nowhere. */
// A machine that HAS reported: folders and ports arrived, the container list did not, and that empty list is
// what the row is about to draw.
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

/* An enrolled machine that has never reported draws no sandbox list at all, and its row already says so. Adding
 * "and desktop sync would not carry containers anyway" is the second sentence of a paragraph whose first one is
 * "we have not heard from this device". */
test(`stays quiet on a machine that has not reported anything yet`, () => {
    expect(manageBlock(device({ sync: enrolled(), platform: `windows`, gap: `unreported` }), undefined)).toBeUndefined();
});

/* A Mac is the hole this leaves open: the desktop app pairs one happily and there is no card to connect it as a
 * device, so the sentence is still worth saying and there is nothing honest to point at. Same for a platform
 * this build has never heard of. */
test(`offers no card for a device this build cannot connect`, () => {
    expect(manageBlock(reported({ platform: `macos` }), undefined)).toEqual({ kind: `connect` });
    expect(manageBlock(reported(), undefined)).toEqual({ kind: `connect` });
    expect(hostCard(`macos`)).toBeUndefined();
    expect(hostCard(undefined)).toBeUndefined();
});

/* THE SWITCH THAT IS OFF BY DEFAULT. Connecting a device grants "Run commands", which is enough to LIST its
 * containers, so the buttons appeared and every one of them was refused by a machine that was otherwise
 * perfectly reachable. Said before the click now, pointing at the connection's own form rather than the card
 * that would add a second one. */
test(`names the sandbox switch when a connected device has not been granted it`, () => {
    const connected = device({ hostId: `my-pc`, online: true, platform: `windows` });
    expect(manageBlock(connected, { platform: `windows`, shell: `on` })).toEqual({
        kind: `sandboxes-off`,
        connection: `my-pc`,
        card: `windows`,
    });
    // Removal is its own grant, because nothing undoes it, so a machine that can do everything else still says
    // which one button will not work.
    expect(manageBlock(connected, { platform: `windows`, shell: `on`, sandboxes: `on` })).toEqual({
        kind: `remove-off`,
        connection: `my-pc`,
        card: `windows`,
    });
    // Both granted: nothing to say, which is the state this whole derivation exists to reach.
    expect(manageBlock(connected, { platform: `windows`, shell: `on`, sandboxes: `on`, sandboxRemove: `on` })).toBeUndefined();
});

// The card is taken from what the CONNECTION pinned rather than from the row, so a machine added through the
// Windows card is edited on the Windows card even if its platform were read some other way later.
test(`opens the card the connection actually came from`, () => {
    const row = device({ hostId: `my-pc`, online: true, platform: `linux` });
    expect(manageBlock(row, { platform: `windows` })).toEqual({ kind: `sandboxes-off`, connection: `my-pc`, card: `windows` });
});

/* A machine that is asleep, or that would not answer, already says so in its own line, and its switches may
 * well be on, since a gap is precisely the reason nothing could be read to find out. Advice about permissions
 * on a device nobody can reach is a second sentence that helps no one. */
test(`stays quiet about permissions on a device that cannot be reached`, () => {
    expect(manageBlock(device({ hostId: `my-pc`, online: false, gap: `offline` }), undefined)).toBeUndefined();
    expect(manageBlock(device({ hostId: `my-pc`, online: true, gap: `scope-off` }), undefined)).toBeUndefined();
    expect(manageBlock(device({ hostId: `my-pc`, online: true, gap: `no-agent` }), undefined)).toBeUndefined();
});

/* THE STATE THIS BLOCK HAD NO WORDS FOR, and the one a reader is most likely to be standing in.
 *
 * A machine reaches this page through two independent doors, and the sync one being wide open says nothing at
 * all about the other. So a device syncing files perfectly — folders, ports, a green badge, a live agent — can
 * have its device socket down, and every verb on the row needs that socket. The row drew no buttons and gave
 * no reason: `online` is a fact this page reads and never printed, which leaves a reader to conclude the buttons
 * were never built rather than that their laptop is asleep. */
test(`says why a connected device that is asleep has no buttons`, () => {
    expect(manageBlock(reported({ hostId: `my-pc`, online: false, platform: `linux` }), { platform: `linux`, sandboxes: `on` })).toEqual({
        kind: `offline`,
        connection: `my-pc`,
        card: `linux`,
    });
    // Never twice: a row with no report of its own already renders "Asleep or offline." from its gap, a few
    // pixels above, and the same sentence in two voices reads as a page that lost its place.
    expect(manageBlock(device({ hostId: `my-pc`, online: false, gap: `offline` }), undefined)).toBeUndefined();
});

/* --- WHAT A DEVICE'S ENROLLMENT SAYS ---------------------------------------------------------------------
 *
 * These moved here with the fact they judge. The staleness rule used to live in the Desktop sync card, where it
 * could only ever be applied to ONE machine — the sandbox's single "syncingFrom" holder — while the store
 * underneath held as many enrollments as the user had made. */

test(`names which half of desktop sync a device holds`, () => {
    expect(syncNote(device({ sync: enrolled(`sync`, NOW) }), NOW)).toBe(`syncing files and ports`);
    expect(syncNote(device({ sync: enrolled(`mirror`, NOW) }), NOW)).toBe(`mirroring ports`);
    // A connected device that was never paired is not missing anything, so it says nothing at all.
    expect(syncNote(device({ hostId: `my-pc` }), NOW)).toBeUndefined();
});

/* AN ENROLLMENT NOBODY HAS EVER USED is a setup that did not finish, and it is indistinguishable from a working
 * one on every other signal a row has: the record exists, the machine is listed, the badge is green. It is the
 * exact failure that let a lost pairing go unnoticed for days. */
test(`treats an enrollment that has never been used as stopped`, () => {
    const never = device({ sync: enrolled() });
    expect(syncStopped(never, NOW)).toBe(true);
    expect(syncNote(never, NOW)).toBe(`enrolled for syncing files and ports, never checked in`);
});

// The heartbeat is the agent's own poll, at most a minute apart, so a live machine is always well inside the
// window and anything hours old means nothing is reaching that folder.
test(`ages an enrollment by its own heartbeat`, () => {
    expect(syncStopped(device({ sync: enrolled(`sync`, NOW - 60_000) }), NOW)).toBe(false);
    const quiet = device({ sync: enrolled(`sync`, NOW - 3 * 60 * 60_000) });
    expect(syncStopped(quiet, NOW)).toBe(true);
    expect(syncNote(quiet, NOW)).toBe(`syncing files and ports: stopped`);
});

/* --- THE FOLDED LINE ---------------------------------------------------------------------------------------
 *
 * Facts are counted and never coloured; warnings keep their ink and are the reason to open the row. The split
 * matters because it decides what a reader can skim past. */
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

test(`counts what is under a folded device, and colours only what wants something`, () => {
    const groups = sandboxGroups(
        [{ sandboxId: `work`, mode: `sync`, localDir: `/home/ada/work`, mutagenStatus: `watching` }],
        [],
        [{ slug: `work`, running: true, image: `img` }],
    );
    expect(deviceSummary(device({ sync: enrolled(`sync`, NOW), report: watching() }), groups, NOW)).toEqual({
        facts: [`1 sandbox`, `1 running`, `syncing files and ports`],
        warnings: [],
    });
});

/* A DEAD LOOP IS THE FAILURE THIS WHOLE AREA EXISTS TO SURFACE: every row beneath it keeps reading exactly as
 * it did the moment before, so the device's own line is the only place it can be said. */
test(`warns on the device's line when its agent has stopped`, () => {
    const summary = deviceSummary(device({ sync: enrolled(`sync`, NOW), report: watching({ agent: { running: false } }) }), [], NOW);
    expect(summary.warnings).toEqual([`agent stopped`]);
    expect(summary.facts).toEqual([`syncing files and ports`]);
});

// A quiet enrollment is a warning rather than a fact, because nothing is reaching that machine's folder — the
// one line on a folded row that must not read as "fine".
test(`moves a quiet enrollment from the facts to the warnings`, () => {
    const summary = deviceSummary(device({ sync: enrolled(`sync`, NOW - 3 * 60 * 60_000), report: watching() }), [], NOW);
    expect(summary.facts).toEqual([]);
    expect(summary.warnings).toEqual([`syncing files and ports: stopped`]);
});
