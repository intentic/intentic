import type { Computer } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { computerDetails, osLabel, osTitle } from "./computerFacts";

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

test(`lists both doors, what it runs on, and which agents are on it`, () => {
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
    expect(computerDetails(row)).toEqual([
        `desktop sync`,
        `connected computer`,
        `x64`,
        `PowerShell 7`,
        `hostname ADA-LAPTOP`,
        `sync agent 0.1.0`,
        `computer agent 0.5.1`,
    ]);
});

// The hostname is worth width only when the row is showing a different name. Machines are routinely enrolled under
// their own hostname, and "my-pc · hostname my-pc" is the kind of line that makes a reader stop reading the rest.
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
    expect(computerDetails(computer({ syncEnrolled: true, report }))).toEqual([`desktop sync`]);
    expect(computerDetails(computer({ label: `ada's box`, syncEnrolled: true, report }))).toEqual([`desktop sync`, `hostname MY-PC`]);
});

/* "Last seen" is the one thing an asleep machine can still say, and it is the difference between a lid closed an
 * hour ago and a computer nobody has switched on since April — which wear the same grey badge. On a machine that
 * is here right now it is noise the badge already carries. */
test(`ages a machine that is not here, and stays quiet about one that is`, () => {
    const lastSeen = Date.now() - 90 * 60_000;
    expect(computerDetails(computer({ hostId: `my-pc`, online: false, lastSeen }))).toEqual([`connected computer`, `last seen 2h ago`]);
    expect(computerDetails(computer({ hostId: `my-pc`, online: true, lastSeen }))).toEqual([`connected computer`]);
});
