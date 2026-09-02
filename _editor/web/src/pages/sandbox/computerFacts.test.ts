import type { Computer } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { computerDoors, hostCard, lastSeenNote, machineFacts, manageBlock, osLabel, osTitle } from "./computerFacts";

/* The row shapes these have to survive are the interesting half. A computer arrives through either of two doors,
 * and the ones that arrive with NO report: a connected computer whose owner never installed the sync agent, a
 * laptop that is asleep, are exactly the rows this derivation exists for: before it they were a name and a badge,
 * so three of them read as the same computer three times. */
const computer = (overrides: Partial<Computer> = {}): Computer => ({
    key: `my-pc`,
    label: `my-pc`,
    syncEnrolled: false,
    ...overrides,
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
    const row = computer({ hostId: `my-pc`, online: true, platform: `windows`, facts: WINDOWS });
    expect(osLabel(row)).toBe(`Windows 11 Pro`);
    expect(osTitle(row)).toBe(`Windows 11 Pro (build 10.0.26100)`);
});

/* The case the tab shipped without: nothing on the machine has described it, and the row still has to say what
 * kind of computer it is. The platform is known from the card it was added with, so this never depends on an agent
 * being installed or the machine being awake. */
test(`falls back to the platform when the machine has never described itself`, () => {
    expect(osLabel(computer({ platform: `windows` }))).toBe(`Windows`);
    expect(osLabel(computer({ platform: `linux` }))).toBe(`Linux`);
    expect(osLabel(computer({ platform: `macos` }))).toBe(`macOS`);
    // A platform this build has never heard of is still shown: the owner knows the word, and a blank row does not
    // become truer by hiding it. Nothing at all to say is the only case that draws nothing.
    expect(osLabel(computer({ platform: `freebsd` }))).toBe(`freebsd`);
    expect(osLabel(computer())).toBeUndefined();
    expect(osTitle(computer({ platform: `windows` }))).toBeUndefined();
});

/* The two questions the row's old single line ran together: what the computer IS, and how this sandbox gets to
 * it. They are separated on screen now, so they are derived separately here, and each door carries the version
 * of the agent behind it, which is what explains a machine that lacks something newer ones show. */
test(`separates what the machine is from how it is reached`, () => {
    const row = computer({
        label: `laptop`,
        syncEnrolled: true,
        hostId: `my-pc`,
        online: true,
        platform: `windows`,
        facts: WINDOWS,
        hostAgent: `0.5.1`,
        report: {
            hostname: `ADA-LAPTOP`,
            os: `win32`,
            agents: { sync: `0.1.0`, host: `0.5.1` },
            sandboxes: [],
            pairings: [],
            ports: [],
            watcher: { running: true },
            capturedAt: 1_700_000_000_000,
        },
    });
    expect(machineFacts(row)).toEqual([`x64`, `PowerShell 7`, `ADA-LAPTOP`]);
    expect(computerDoors(row)).toEqual([{ name: `desktop sync`, version: `0.1.0` }]);
});

// The hostname is worth width only when the row is showing a different name. Machines are routinely enrolled under
// their own hostname, and "my-pc · my-pc" is the kind of line that makes a reader stop reading the rest.
test(`repeats the hostname only when the row is called something else`, () => {
    const report = {
        hostname: `MY-PC`,
        os: `linux`,
        agents: {},
        sandboxes: [],
        pairings: [],
        ports: [],
        watcher: { running: true },
        capturedAt: 1_700_000_000_000,
    };
    expect(machineFacts(computer({ syncEnrolled: true, report }))).toEqual([]);
    expect(machineFacts(computer({ label: `ada's box`, syncEnrolled: true, report }))).toEqual([`MY-PC`]);
    // A door with no report behind it is still a door: it just cannot say which version answered.
    expect(computerDoors(computer({ syncEnrolled: true }))).toEqual([{ name: `desktop sync` }]);
});

/* "Last seen" is the one thing an asleep machine can still say, and it is the difference between a lid closed an
 * hour ago and a computer nobody has switched on since April, which wear the same grey badge. On a machine that
 * is here right now it is noise the badge already carries.
 *
 * 90 minutes reads "1h ago", not "2h": timeAgo rounds DOWN at every tier, so "1h ago" spans the whole hour after
 * the first and never claims more time has passed than has. It rounded to nearest here until the two age
 * formatters this app had were made one: the other floored, so the same lid closed at the same moment read an
 * hour apart on two screens. */
test(`ages a machine that is not here, and stays quiet about one that is`, () => {
    const lastSeen = Date.now() - 90 * 60_000;
    expect(lastSeenNote(computer({ hostId: `my-pc`, online: false, lastSeen }))).toBe(`last seen 1h ago`);
    expect(lastSeenNote(computer({ hostId: `my-pc`, online: true, lastSeen }))).toBeUndefined();
});

/* WHY A ROW HAS NO BUTTONS: the derivation the parity complaint is actually about.
 *
 * A machine paired by the desktop app is enrolled for desktop sync alone, and that door never carries containers.
 * So the row rendered folders, ports, and an empty sandbox list with no verbs on it, while the desktop app's own
 * window managed the very same containers on the very same machine. The remedy existed the whole time and was
 * named nowhere. */
// A machine that HAS reported: folders and ports arrived, the container list did not, and that empty list is
// what the row is about to draw.
const reported = (overrides: Partial<Computer> = {}): Computer =>
    computer({
        syncEnrolled: true,
        report: {
            hostname: `laptop`,
            os: `win32`,
            agents: { sync: `1.183.0` },
            sandboxes: [],
            pairings: [],
            ports: [],
            watcher: { running: true },
            capturedAt: 1_700_000_000_000,
        },
        ...overrides,
    });

test(`says a sync-only computer must be connected before its sandboxes can be managed`, () => {
    expect(manageBlock(reported({ platform: `windows` }), undefined)).toEqual({ kind: `connect`, card: `windows` });
    expect(manageBlock(reported({ platform: `linux` }), undefined)).toEqual({ kind: `connect`, card: `linux` });
});

/* An enrolled machine that has never reported draws no sandbox list at all, and its row already says so. Adding
 * "and desktop sync would not carry containers anyway" is the second sentence of a paragraph whose first one is
 * "we have not heard from this computer". */
test(`stays quiet on a machine that has not reported anything yet`, () => {
    expect(manageBlock(computer({ syncEnrolled: true, platform: `windows`, gap: `unreported` }), undefined)).toBeUndefined();
});

/* A Mac is the hole this leaves open: the desktop app pairs one happily and there is no card to connect it as a
 * computer, so the sentence is still worth saying and there is nothing honest to point at. Same for a platform
 * this build has never heard of. */
test(`offers no card for a computer this build cannot connect`, () => {
    expect(manageBlock(reported({ platform: `macos` }), undefined)).toEqual({ kind: `connect` });
    expect(manageBlock(reported(), undefined)).toEqual({ kind: `connect` });
    expect(hostCard(`macos`)).toBeUndefined();
    expect(hostCard(undefined)).toBeUndefined();
});

/* THE SWITCH THAT IS OFF BY DEFAULT. Connecting a computer grants "Run commands", which is enough to LIST its
 * containers, so the buttons appeared and every one of them was refused by a machine that was otherwise
 * perfectly reachable. Said before the click now, pointing at the connection's own form rather than the card
 * that would add a second one. */
test(`names the sandbox switch when a connected computer has not been granted it`, () => {
    const connected = computer({ hostId: `my-pc`, online: true, platform: `windows` });
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
    const row = computer({ hostId: `my-pc`, online: true, platform: `linux` });
    expect(manageBlock(row, { platform: `windows` })).toEqual({ kind: `sandboxes-off`, connection: `my-pc`, card: `windows` });
});

/* A machine that is asleep, or that would not answer, already says so in its own line, and its switches may
 * well be on, since a gap is precisely the reason nothing could be read to find out. Advice about permissions
 * on a computer nobody can reach is a second sentence that helps no one. */
test(`stays quiet about permissions on a computer that cannot be reached`, () => {
    expect(manageBlock(computer({ hostId: `my-pc`, online: false, gap: `offline` }), undefined)).toBeUndefined();
    expect(manageBlock(computer({ hostId: `my-pc`, online: true, gap: `scope-off` }), undefined)).toBeUndefined();
    expect(manageBlock(computer({ hostId: `my-pc`, online: true, gap: `no-agent` }), undefined)).toBeUndefined();
});
