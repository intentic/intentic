import { type Device, environmentOf, machinesOf, windowsPathOf, wslPathOf } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";

// The join behind "one PC, two doors": Windows and the WSL distros on it answer `hostname` alike, so a distro joins
// the machine whose name it carries and nothing else does. Tested beside the daemon's reader of it, like
// hostRunningSandbox; the contract directory holding it is at its layout cap.

const device = (key: string, over: Partial<Device> = {}): Device => ({ key, label: key, ...over });

const WINDOWS = { os: "Microsoft Windows 11 Home", arch: "x64", shell: "PowerShell 7", home: "C:\\Users\\radar", roots: ["C:\\Users\\radar"] };
const ARCH = { os: "Arch Linux", arch: "x64", shell: "/usr/bin/zsh", home: "/home/radarsu", roots: ["/home/radarsu"] };

test("folds a Windows install and the distro on it into one machine, Windows first", () => {
    const distro = device("rog-wsl-arch", { facts: { ...ARCH, hostname: "radarsu-rog", wsl: { distro: "Arch" } } });
    const windows = device("radarsu-rog", { facts: { ...WINDOWS, hostname: "radarsu-rog" } });
    const [machine, ...rest] = machinesOf([distro, windows]);
    expect(rest).toEqual([]);
    expect(machine).toMatchObject({ key: "radarsu-rog", label: "radarsu-rog" });
    expect(machine?.environments.map((environment) => environment.key)).toEqual(["radarsu-rog", "rog-wsl-arch"]);
});

// The report is the older evidence and still counts: a sync-only distro folds onto the Windows card beside it.
test("reads the hostname off the report when the door has no facts", () => {
    const synced = device("radarsu-rog", {
        sync: { machine: "radarsu-rog", mode: "sync" },
        report: { hostname: "radarsu-rog", os: "linux", wsl: { distro: "Arch" }, pairings: [], ports: [], agent: { running: true }, capturedAt: 1 },
    });
    const windows = device("radarsu-rog:win", { hostId: "win", facts: { ...WINDOWS, hostname: "RADARSU-ROG" } });
    expect(machinesOf([synced, windows]).map((machine) => machine.environments.length)).toEqual([2]);
});

test("keeps two native installs apart even when they share a name", () => {
    const linux = device("box", { facts: { ...ARCH, hostname: "box" } });
    const windows = device("box:win", { hostId: "win", facts: { ...WINDOWS, hostname: "box" } });
    expect(machinesOf([linux, windows]).map((machine) => machine.key)).toEqual(["box", "box:win"]);
});

test("keeps a lone device's own key, so its address does not change", () => {
    const lone = device("ada-laptop", { facts: { ...ARCH, hostname: "ada" } });
    expect(machinesOf([lone])).toEqual([{ key: "ada-laptop", label: "ada-laptop", environments: [lone] }]);
    // No hostname at all is a device that has never described itself: a machine of its own.
    expect(machinesOf([device("quiet")])[0]?.environments).toHaveLength(1);
});

// Facts arrive at connect and no scope withholds them, so they outrank a report — which "Run commands" can.
test("reads the environment off facts before the report, and off an old agent's facts not at all", () => {
    expect(environmentOf({ hostname: "rog", wsl: { distro: "Arch" } }, undefined)).toBe("wsl:Arch");
    expect(environmentOf({ hostname: "rog" }, undefined)).toBe("native");
    expect(environmentOf({}, undefined)).toBeUndefined();
    expect(environmentOf({}, { hostname: "rog", os: "linux", pairings: [], ports: [], agent: { running: true }, capturedAt: 1 })).toBe("native");
});

test("names the same folder from either side", () => {
    expect(wslPathOf("C:\\Users\\radar\\proj")).toBe("/mnt/c/Users/radar/proj");
    expect(wslPathOf("D:/data/")).toBe("/mnt/d/data");
    expect(wslPathOf("/home/radarsu")).toBeUndefined();
    expect(windowsPathOf("Arch", "/home/radarsu/proj")).toBe("\\\\wsl.localhost\\Arch\\home\\radarsu\\proj");
});
