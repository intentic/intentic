import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import type { MachineConfig } from "./machine.js";
import { autoUpgradeDecision, type AutoUpgradeReading, retryAfterMs, startAutoUpgrade, upgradeHeldBy } from "./auto-upgrade.js";

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

describe("a release this machine rolled back from", () => {
    // The agent that crash-looped here was put back to the one before (agent-trial.ts); going onto it again would loop.
    it("is never the target again, and a newer release is", () => {
        const skipped = { skippedAgent: { version: "1.305.0", at: NOW - HOUR } };
        expect(autoUpgradeDecision(reading({ published: "1.305.0", config: skipped }))).toBeUndefined();
        expect(autoUpgradeDecision(reading({ children: ["1.305.0"], config: skipped }))).toBeUndefined();
        expect(autoUpgradeDecision(reading({ published: "1.306.0", config: skipped }))).toEqual({ level: false, target: "1.306.0" });
    });
});

describe("upgradeHeldBy", () => {
    // Restarting the agent between parking a container and starting its replacement is what left sandboxes down.
    it("names every sandbox ic says is mid-swap, with this process's own flows, once each", () => {
        // ic's verdicts (`ic sandbox swaps`), not the agent's: a cutover whose ic died is interrupted, however recent its start.
        const swaps = [
            { slug: "work", phase: "cutover", at: NOW - 60_000, cutoverInProgress: true },
            { slug: "dead", phase: "cutover", at: NOW - 60_000, cutoverInProgress: false },
            { slug: "proving", phase: "probation", at: NOW - 60_000, cutoverInProgress: false },
        ];
        expect(upgradeHeldBy(new Set(["work", "mine"]), swaps)).toEqual(["work", "mine"]);
        expect(upgradeHeldBy(new Set(), swaps)).toEqual(["work"]);
        expect(upgradeHeldBy(new Set(), [])).toEqual([]);
    });
});

describe("retryAfterMs", () => {
    it("doubles per failure from an hour and never waits longer than a day", () => {
        expect([1, 2, 3, 4, 5, 6, 12].map((count) => retryAfterMs(count) / HOUR)).toEqual([1, 2, 4, 8, 16, 24, 24]);
    });
});

describe("the upgrade scheduler", () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    const scheduler = () => {
        const readSwaps = jest.fn(async () => []);
        const readMachineConfig = jest.fn(async (): Promise<MachineConfig> => ({}));
        const publishedVersion = jest.fn(async (): Promise<string | undefined> => "1.305.0");
        const installedChildren = jest.fn(async () => ["1.304.0"]);
        const launchUpgrade = jest.fn(async (_level: boolean) => undefined);
        const log = jest.fn((_line: string) => undefined);
        const upgrade = startAutoUpgrade(log, {
            readSwaps, readMachineConfig, publishedVersion, installedChildren, launchUpgrade,
            installedBuild: () => "1.304.0",
        });
        return { upgrade, readSwaps, readMachineConfig, publishedVersion, installedChildren, launchUpgrade, log };
    };

    it("coalesces nudges during a check into one later pass", async () => {
        const world = scheduler();
        const pending = Promise.withResolvers<string | undefined>();
        world.publishedVersion.mockImplementationOnce(() => pending.promise);
        world.upgrade.nudge();
        await advanceTimersByTimeAsync(30_000);
        expect(world.readSwaps).toHaveBeenCalledTimes(1);
        world.upgrade.nudge();
        world.upgrade.nudge();
        await advanceTimersByTimeAsync(60_000);
        expect(world.readSwaps).toHaveBeenCalledTimes(1);
        pending.resolve("1.305.0");
        await advanceTimersByTimeAsync(0);
        expect(world.launchUpgrade).toHaveBeenCalledTimes(1);
        await advanceTimersByTimeAsync(29_999);
        expect(world.readSwaps).toHaveBeenCalledTimes(1);
        await advanceTimersByTimeAsync(1);
        expect(world.readSwaps).toHaveBeenCalledTimes(2);
        world.upgrade.stop();
    });

    it("does not launch or re-arm after stop during release discovery", async () => {
        const world = scheduler();
        const pending = Promise.withResolvers<string | undefined>();
        world.publishedVersion.mockImplementationOnce(() => pending.promise);
        world.upgrade.nudge();
        await advanceTimersByTimeAsync(30_000);
        world.upgrade.stop();
        world.upgrade.nudge();
        pending.resolve("1.305.0");
        await advanceTimersByTimeAsync(2 * HOUR);
        expect(world.launchUpgrade).not.toHaveBeenCalled();
        expect(world.log).not.toHaveBeenCalled();
        expect(world.readSwaps).toHaveBeenCalledTimes(1);
        expect(jest.getTimerCount()).toBe(0);
    });

    it("does not reach for releases after stop during the config read", async () => {
        const world = scheduler();
        const pending = Promise.withResolvers<MachineConfig>();
        world.readMachineConfig.mockImplementationOnce(() => pending.promise);
        world.upgrade.nudge();
        await advanceTimersByTimeAsync(30_000);
        world.upgrade.stop();
        pending.resolve({});
        await advanceTimersByTimeAsync(0);
        expect(world.publishedVersion).not.toHaveBeenCalled();
        expect(world.installedChildren).not.toHaveBeenCalled();
        expect(jest.getTimerCount()).toBe(0);
    });

    it("reports a failed swap read and keeps the next scheduled check", async () => {
        const world = scheduler();
        world.readSwaps.mockRejectedValueOnce(new Error("ic unavailable"));
        world.upgrade.nudge();
        await advanceTimersByTimeAsync(30_000);
        expect(world.log).toHaveBeenCalledWith("auto-upgrade: skipped this round — ic unavailable");
        expect(world.launchUpgrade).not.toHaveBeenCalled();
        await advanceTimersByTimeAsync(HOUR);
        expect(world.readSwaps).toHaveBeenCalledTimes(2);
        expect(world.launchUpgrade).toHaveBeenCalledWith(false);
        world.upgrade.stop();
    });
});
