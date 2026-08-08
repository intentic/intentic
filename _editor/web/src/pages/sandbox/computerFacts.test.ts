import type { Computer } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { computerDoors, lastSeenNote, machineFacts, osLabel, osTitle } from "./computerFacts";

/* The row shapes these have to survive are the interesting half. A computer arrives through either of two doors,
 * and the ones that arrive with NO report — a connected computer whose owner never installed the sync agent, a
 * laptop that is asleep — are exactly the rows this derivation exists for: before it they were a name and a badge,
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
// qualifies — so the row keeps the name and the precise string stays reachable.
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
 * it. They are separated on screen now, so they are derived separately here — and each door carries the version
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
    expect(computerDoors(row)).toEqual([
        { name: `desktop sync`, version: `0.1.0` },
        { name: `connected computer`, version: `0.5.1` },
    ]);
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
    // A door with no report behind it is still a door — it just cannot say which version answered.
    expect(computerDoors(computer({ syncEnrolled: true }))).toEqual([{ name: `desktop sync` }]);
});

/* "Last seen" is the one thing an asleep machine can still say, and it is the difference between a lid closed an
 * hour ago and a computer nobody has switched on since April — which wear the same grey badge. On a machine that
 * is here right now it is noise the badge already carries. */
test(`ages a machine that is not here, and stays quiet about one that is`, () => {
    const lastSeen = Date.now() - 90 * 60_000;
    expect(lastSeenNote(computer({ hostId: `my-pc`, online: false, lastSeen }))).toBe(`last seen 2h ago`);
    expect(lastSeenNote(computer({ hostId: `my-pc`, online: true, lastSeen }))).toBeUndefined();
});
