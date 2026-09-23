import { autoUpgradeDecision, type AutoUpgradeReading, retryAfterMs } from "./auto-upgrade.js";

const HOUR = 60 * 60_000;
const NOW = 1_800_000_000_000;

const reading = (overrides: Partial<AutoUpgradeReading> = {}): AutoUpgradeReading => ({
    own: "1.304.0",
    children: ["1.304.0"],
    published: undefined,
    config: {},
    now: NOW,
    ...overrides,
});

describe("autoUpgradeDecision", () => {
    it("does nothing on a machine already level with the channel", () => {
        expect(autoUpgradeDecision(reading({ published: "1.304.0" }))).toBeUndefined();
    });

    it("moves the machine onto a newly published release", () => {
        expect(autoUpgradeDecision(reading({ published: "1.305.0" }))).toEqual({ level: false, target: "1.305.0" });
    });

    // The failure this tick exists for as much as new releases: one side left behind by a failed or missed upgrade.
    it("levels a side found behind even with nothing new published", () => {
        expect(autoUpgradeDecision(reading({ children: ["1.303.0"] }))).toEqual({ level: true, target: "1.304.0" });
        expect(autoUpgradeDecision(reading({ own: "1.303.0", children: ["1.304.0"] }))).toEqual({ level: true, target: "1.304.0" });
    });

    // Updates off means no release the owner did not take; it never means leaving the PC's sides on two releases.
    it("with updates off, levels the machine but never reaches for the channel", () => {
        const off = { agentUpdates: false } as const;
        expect(autoUpgradeDecision(reading({ published: "1.305.0", config: off }))).toBeUndefined();
        expect(autoUpgradeDecision(reading({ published: "1.305.0", children: ["1.303.0"], config: off }))).toEqual({ level: true, target: "1.304.0" });
    });

    // A machine running a build from source is somebody's workbench: nothing is done to it unasked.
    it("never touches a machine whose own agent was built from source", () => {
        expect(autoUpgradeDecision(reading({ own: "0.0.0", published: "1.305.0", children: ["1.303.0"] }))).toBeUndefined();
    });

    // A distro that did not answer is not a distro on another release.
    it("reads a side that did not answer as no evidence", () => {
        expect(autoUpgradeDecision(reading({ children: [undefined] }))).toBeUndefined();
    });

    it("backs off from a target that failed, and tries it again once the wait is over", () => {
        const failed = { upgradeFailure: { target: "1.305.0", count: 3, at: NOW - 3 * HOUR } };
        expect(autoUpgradeDecision(reading({ published: "1.305.0", config: failed }))).toBeUndefined();
        expect(autoUpgradeDecision(reading({ published: "1.305.0", config: failed, now: NOW + 2 * HOUR }))).toEqual({ level: false, target: "1.305.0" });
        // A newer release is a new target: the old one's failures say nothing about it.
        expect(autoUpgradeDecision(reading({ published: "1.306.0", config: failed }))).toEqual({ level: false, target: "1.306.0" });
    });
});

describe("retryAfterMs", () => {
    it("doubles per failure from an hour and never waits longer than a day", () => {
        expect([1, 2, 3, 4, 5, 6, 12].map((count) => retryAfterMs(count) / HOUR)).toEqual([1, 2, 4, 8, 16, 24, 24]);
    });
});
