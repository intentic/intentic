import { describe, expect, it } from "bun:test";
import type { UpgradeOutcome } from "../upgrade.js";
import { machineTarget, type MachineIo, upgradeMachine } from "./machine-upgrade.js";

describe("machineTarget", () => {
    // The newest thing this PC or the channel has: a side already ahead pulls the rest of the machine up to it.
    it("is the newest release among the channel and every side of the machine", () => {
        expect(machineTarget("1.305.0", ["1.304.0", "1.303.0"])).toBe("1.305.0");
        expect(machineTarget("1.304.0", ["1.304.0", "1.306.0"])).toBe("1.306.0");
        expect(machineTarget(undefined, ["1.304.0", undefined, "1.305.1"])).toBe("1.305.1");
    });

    // 0.0.0 marks a build from source, which no release can be compared with, so it never sets the machine's target.
    it("never takes a from-source build as a target, and has none with nothing to go on", () => {
        expect(machineTarget(undefined, ["0.0.0"])).toBeUndefined();
        expect(machineTarget("1.305.0", ["0.0.0"])).toBe("1.305.0");
        expect(machineTarget(undefined, [])).toBeUndefined();
    });
});

// A stand-in PC: every call is recorded in order, so the tests read as the transcript of one upgrade.
const machine = (overrides: Partial<MachineIo> = {}, versions: Readonly<Record<string, string | undefined>> = {}) => {
    const calls: string[] = [];
    const io: MachineIo = {
        leg: undefined,
        windowsRoot: async () => await Promise.resolve(undefined),
        delegate: (agent, args) => {
            calls.push(`delegate ${agent} ${args.join(" ")}`);
            return 0;
        },
        children: async () => await Promise.resolve(["archlinux", "Ubuntu"]),
        published: async () => {
            calls.push("published");
            return await Promise.resolve("1.305.0");
        },
        installedHere: () => "1.304.0",
        installedIn: async (distro) => await Promise.resolve(versions[distro] ?? "1.304.0"),
        upgradeIn: async (distro, target) => {
            calls.push(`leg ${distro} → ${target}`);
            return await Promise.resolve(true);
        },
        upgradeHere: async (target) => {
            calls.push(`here → ${target}`);
            return await Promise.resolve<UpgradeOutcome>({ kind: "upgraded", from: "1.304.0", to: target });
        },
        recorded: async (failed) => {
            calls.push(`recorded ${failed ?? "success"}`);
            return await Promise.resolve();
        },
        ...overrides,
    };
    return { io, calls };
};

const run = async (io: MachineIo, ask = { force: false, level: false }): Promise<boolean> => await upgradeMachine(io, ask, () => undefined);

describe("upgradeMachine", () => {
    // Each side ends on one release, and the side that was asked goes last: its restart ends the stream a sandbox reads.
    it("brings every distro and then this side to one release", async () => {
        const { io, calls } = machine();
        expect(await run(io)).toBe(true);
        expect(calls).toEqual(["published", "leg archlinux → 1.305.0", "leg Ubuntu → 1.305.0", "here → 1.305.0", "recorded success"]);
    });

    it("pulls the whole machine up to a side already ahead of the channel", async () => {
        const { io, calls } = machine({}, { Ubuntu: "1.306.0" });
        await run(io);
        expect(calls).toContain("leg archlinux → 1.306.0");
        expect(calls).toContain("here → 1.306.0");
    });

    // Levelling is what the automatic tick asks for with updates off: it may never reach for a release no side runs.
    it("levels without asking the release channel", async () => {
        const { io, calls } = machine({}, { archlinux: "1.304.2" });
        await run(io, { force: false, level: true });
        expect(calls).not.toContain("published");
        expect(calls).toContain("here → 1.304.2");
    });

    // The distro that was asked never upgrades only itself: the Windows side does the whole PC, this distro included.
    it("hands the job to the Windows side when it runs inside a distro that has one", async () => {
        const { io, calls } = machine({ windowsRoot: async () => await Promise.resolve("/mnt/c/Users/a/.intentic/machine/bin/intentic-machine.exe") });
        expect(await run(io, { force: true, level: false })).toBe(true);
        expect(calls).toEqual(["delegate /mnt/c/Users/a/.intentic/machine/bin/intentic-machine.exe upgrade --force"]);
    });

    it("upgrades only itself, to exactly the release it was handed, when it is one leg of a machine-wide upgrade", async () => {
        const { io, calls } = machine({ leg: "1.305.0" });
        expect(await run(io)).toBe(true);
        expect(calls).toEqual(["here → 1.305.0"]);
    });

    // A side that could not land is the machine not landing: the target is remembered so the tick backs off from it.
    it("reports a failed side, finishes the rest, and records the target for the tick to back off from", async () => {
        const { io, calls } = machine({
            upgradeIn: async (distro, target) => {
                calls.push(`leg ${distro} → ${target}`);
                return await Promise.resolve(distro !== "archlinux");
            },
        });
        expect(await run(io)).toBe(false);
        expect(calls).toContain("leg Ubuntu → 1.305.0");
        expect(calls).toContain("here → 1.305.0");
        expect(calls.at(-1)).toBe("recorded 1.305.0");
    });

    it("changes nothing when neither the channel nor any side names a release", async () => {
        const { io, calls } = machine({
            published: async () => await Promise.resolve(undefined),
            installedHere: () => "0.0.0",
            installedIn: async () => await Promise.resolve(undefined),
        });
        expect(await run(io)).toBe(false);
        expect(calls.some((call) => call.startsWith("leg") || call.startsWith("here"))).toBe(false);
    });

    // Levelling a machine none of whose sides runs a release has nothing to move it to, which is not a failure.
    it("levels nothing, and fails nothing, on a machine with no released side", async () => {
        const { io, calls } = machine({ installedHere: () => "0.0.0", installedIn: async () => await Promise.resolve(undefined) });
        expect(await run(io, { force: false, level: true })).toBe(true);
        expect(calls).toEqual([]);
    });
});
