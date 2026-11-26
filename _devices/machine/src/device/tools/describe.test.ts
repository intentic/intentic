import { LONG_OUTAGE_ATTEMPTS } from "@intentic/sandbox-contract/peer-dial";
import type { LinkReading } from "../config.js";
import { agentLines, linkFacts, powerLines, wslMemoryLines } from "./describe.js";
import { icOverrides } from "./ic-binary.js";

// What a sandbox is told about the links this machine holds to OTHER sandboxes. Counts and an age, never addresses:
// they belong to the same owner but not to the sandbox asking, and the count is all its card needs to offer the drop.
const down = (failures: number, since: number): LinkReading => ({ state: "connecting", outage: { failures, since } });
const gone = (goneSince: number): LinkReading => ({ state: "connecting", goneSince });

test("reports how many links are held and how many are to sandboxes that no longer exist, and nothing else", () => {
    expect(
        linkFacts({
            "https://a.example": { state: "open" },
            "https://b.example": gone(1_700_000_500_000),
            "https://c.example": gone(1_700_000_000_000),
        }),
    ).toEqual({ total: 3, unreachable: 2, unreachableSince: 1_700_000_000_000 });
});

// (2026-11-17) Every sandbox's Devices page offers to drop what this counts, so a sibling that is only down (restarting,
// asleep, on a computer that is off) must never be counted, however long it has failed.
test("a link that is only down is never unreachable, however many dials it has failed", () => {
    expect(linkFacts({ "https://a.example": down(LONG_OUTAGE_ATTEMPTS * 50, 1_700_000_000_000) })).toEqual({ total: 1, unreachable: 0 });
});

// Not the same fact as "none unreachable": an agent that has not stamped yet, or is too old to, has said nothing,
// and a card that read that as tidy would be answering on no evidence.
test("says nothing at all when the agent has not stamped its links", () => {
    expect(linkFacts(undefined)).toBeUndefined();
});

// (2026-10-07) A setup script's leftover IC_URL put a three-week-old ic on rog, and finding which ic answered took a dozen
// calls: describe names it, its version and file time, and what in the agent's environment steers it.
test("describe says which ic answers, from where and how old, what overrides steer it, and why the agent before ended", () => {
    const lines = agentLines(
        { path: "C:\\Users\\me\\.intentic\\ic\\bin\\ic.exe", version: "1.380.0", modified: "2026-09-16T10:00:00.000Z" },
        ["IC_URL=http://localhost:4321/desktop"],
        { version: "1.401.0", startedAt: "2026-10-11T08:00:00.000Z", previous: "the agent before this one (pid 4) ended: it was stopped." },
    );
    expect(lines).toEqual([
        "Agent: intentic-machine 1.401.0, running since 2026-10-11T08:00:00.000Z; its own logs are read with device_logs",
        "Before it: the agent before this one (pid 4) ended: it was stopped.",
        "ic: 1.380.0 at C:\\Users\\me\\.intentic\\ic\\bin\\ic.exe (written 2026-09-16T10:00:00.000Z)",
        "Overrides in the agent's environment: IC_URL=http://localhost:4321/desktop",
    ]);
    expect(agentLines(undefined, [], { version: "1.401.0" })[1]).toMatch(/^ic: none answers here/);
});

test("the overrides shown are ic's and intentic's own, sorted, with a secret's value shown only by its length", () => {
    expect(icOverrides({ PATH: "/bin", INTENTIC_LOG_DIR: "/l", IC_URL: "http://x", INTENTIC_SETUP_TOKEN: "abcdef", ICONS: "no" })).toEqual([
        "IC_URL=http://x",
        "INTENTIC_LOG_DIR=/l",
        "INTENTIC_SETUP_TOKEN=<6 characters>",
    ]);
});

// (2026-11-22) What the computer's own power settings would do to work left running, in the agent's sentences, and that
// they are its owner's to change: a model reading describe is told, and told not to reach for powercfg itself.
test("describe says what the power settings would do, that nothing would where nothing would, and nothing where they were not read", () => {
    expect(powerLines({})).toEqual([]);
    expect(powerLines({ power: { at: 1, utcOffsetMinutes: 60, findings: [] } })).toEqual([
        "Power settings: nothing in this computer's own settings would put it to sleep or cut it off while work is left running.",
    ]);
    const [line] = powerLines({
        power: {
            at: 1,
            utcOffsetMinutes: 60,
            findings: [
                { id: "sleep-idle", power: "ac", afterSeconds: 18_000, fixable: true, text: "Sleeps after 5 hours without input on mains power (plan: Turbo)." },
                { id: "update-restart", window: { fromHour: 2, toHour: 8 }, fixable: false, text: "Windows Update may restart it between 02:00 and 08:00 local time." },
            ],
        },
    });
    expect(line).toContain("Sleeps after 5 hours without input on mains power (plan: Turbo). Windows Update may restart it between 02:00 and 08:00 local time.");
    expect(line).toContain("do not change them yourself");
});

const GIB = 1024 ** 3;

test("describe says a WSL VM too big for its PC is the owner's to change, a new size not yet in force, and nothing otherwise", () => {
    const configPath = "C:\\Users\\radar\\.wslconfig";
    expect(wslMemoryLines({})).toEqual([]);
    expect(wslMemoryLines({ wslMemory: { configPath, configuredGb: 22 }, engine: { memoryBytes: 21.5 * GIB, cpus: 16 } })).toEqual([]);
    const [fit] = wslMemoryLines({
        wslMemory: {
            configPath,
            configuredGb: 22,
            fit: {
                at: 1,
                windowMs: 4 * 3_600_000,
                readings: 48,
                totalBytes: 31.4 * GIB,
                lowLineBytes: 3.14 * GIB,
                underLowShare: 0.875,
                availableMedianBytes: 2.6 * GIB,
                vmMedianBytes: 16.2 * GIB,
                outsideBytes: 12.5 * GIB,
                configuredGb: 22,
                proposedGb: 15,
                atFloor: false,
                text: "Windows was short.",
            },
        },
    });
    expect(fit).toBe(
        "WSL VM memory: Windows was short. Changing it is the owner's: the sandbox asks them on a card, and it takes effect only when WSL restarts, which restarts every sandbox on this PC, so do not edit C:\\Users\\radar\\.wslconfig or run wsl --shutdown yourself.",
    );
    // Written, not yet in force: the engine still runs with what the VM started with.
    expect(wslMemoryLines({ wslMemory: { configPath, configuredGb: 15 }, engine: { memoryBytes: 21.5 * GIB, cpus: 16 } })).toEqual([
        "WSL VM memory: C:\\Users\\radar\\.wslconfig sets memory=15GB, but the VM still runs with 21.5 GiB: the new size takes effect when WSL restarts (wsl --shutdown), which restarts every sandbox on this PC. That is the owner's to do.",
    ]);
});
