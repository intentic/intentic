import type { Services } from "../composition.js";
import { createPeerHub } from "../peers/peer-hub.js";
import { HOST_PEER, type HostClient, hostConnections, hostSummaries } from "./host-peer.js";
import {
    type Device,
    environmentKeyOf,
    environmentOf,
    HOST_NATIVE_ENVIRONMENT,
    hostEntryOf,
    hostConnectionKey,
    hostEnvironmentOf,
    type DeviceFacts,
    type DeviceScopes,
    machinesOf,
    windowsPathOf,
    wslPathOf,
} from "@intentic/sandbox-contract";
import { test, expect } from "bun:test";

// The join behind "one PC, two doors": environments of one card are one computer by construction, and a distro with a
// card of its own joins the machine whose hostname it carries, which is the one fact that makes a name safe to join
// on. Tested beside the daemon's reader of it, like hostRunningSandbox; the contract directory holding it is at its
// layout cap.

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
    // A carded machine is addressed by its card and an uncarded one by its own key; neither is the other's.
    expect(machinesOf([linux, windows]).map((machine) => machine.key)).toEqual(["box", "win"]);
    expect(machinesOf([linux, windows]).map((machine) => machine.environments.length)).toEqual([1, 1]);
});

// ONE CARD IS ONE COMPUTER. Hub liveness resets when the daemon restarts, so a side nobody has reached since holds no
// facts and no report — the whole of the hostname evidence — and without the card every sleeping environment of a PC
// stands as a machine of its own, which is a fleet of two computers drawn as five.
test("folds a card's environments into one machine while its sides are asleep", () => {
    const distro = hostConnectionKey("radarsu-omen", "wsl:archlinux");
    const ubuntu = hostConnectionKey("radarsu-omen", "wsl:Ubuntu-22.04");
    const machines = machinesOf([
        device(distro, { hostId: distro, platform: "linux", facts: { ...ARCH, hostname: "radarsu-omen", wsl: { distro: "archlinux" } } }),
        device("radarsu-omen", { hostId: "radarsu-omen", platform: "windows", gap: "offline" }),
        device(ubuntu, { hostId: ubuntu, platform: "linux", gap: "offline" }),
    ]);
    const [machine, ...rest] = machines;
    expect(rest).toEqual([]);
    // Named after its card, which is what its tools are called after, not after the hostname one side happened to say.
    expect(machine).toMatchObject({ key: "radarsu-omen", label: "radarsu-omen" });
    // Native leads even when it has never described itself: the door id says which side it is.
    expect(machine?.environments.map((environment) => environment.key)).toEqual(["radarsu-omen", distro, ubuntu]);
});

// The other half of the same computer: a distro connected as a card of its own, which is what the Windows side's
// "connect this distro" link still mints. The hostname joins it to the card it runs on, and that join carries the
// card's other environments with it.
test("joins a separately carded distro to the machine whose hostname it carries", () => {
    const arch = hostConnectionKey("rog", "wsl:archlinux");
    const machines = machinesOf([
        device("rog", { hostId: "rog", facts: { ...WINDOWS, hostname: "rog" } }),
        device(arch, { hostId: arch, gap: "offline" }),
        device("rog-wsl-ubuntu", { hostId: "rog-wsl-ubuntu", facts: { ...ARCH, hostname: "rog", wsl: { distro: "Ubuntu" } } }),
    ]);
    const [machine, ...rest] = machines;
    expect(rest).toEqual([]);
    expect(machine?.key).toBe("rog");
    expect(machine?.environments.map((environment) => environment.key)).toEqual(["rog", arch, "rog-wsl-ubuntu"]);
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

// ONE CARD, ONE COMPUTER, A CONNECTION PER OS INSTALL ON IT. The native environment's key is the card id itself, so a
// machine with one OS install is addressed exactly as before and a sibling is a longer name rather than a second card.
test("names a machine's environments without giving any of them a card of its own", () => {
    expect(hostConnectionKey("rog", HOST_NATIVE_ENVIRONMENT)).toBe("rog");
    expect(hostConnectionKey("rog", "wsl:archlinux")).toBe("rog::wsl:archlinux");
    // Both directions, since the store and the hub only ever hold the key and the grant only ever hangs off the card.
    expect(hostEntryOf("rog")).toBe("rog");
    expect(hostEntryOf("rog::wsl:archlinux")).toBe("rog");
    expect(hostEnvironmentOf("rog")).toBe(HOST_NATIVE_ENVIRONMENT);
    expect(hostEnvironmentOf("rog::wsl:archlinux")).toBe("wsl:archlinux");
    // The single colon inside an environment key is why the separator is doubled: a distro named with one cannot
    // split a card in two.
    expect(hostEntryOf(hostConnectionKey("rog", "wsl:my:distro"))).toBe("rog");
    expect(hostEnvironmentOf(hostConnectionKey("rog", "wsl:my:distro"))).toBe("wsl:my:distro");
});

// The key is read off what the agent reported at connect, so the distro carries the name WSL registered — the one
// `wsl -l -q` prints and `in: "wsl:<name>"` accepts.
test("reads a connecting machine's environment off its own facts", () => {
    expect(environmentKeyOf({ wsl: { distro: "archlinux" } })).toBe("wsl:archlinux");
    expect(environmentKeyOf({})).toBe(HOST_NATIVE_ENVIRONMENT);
});

// The daemon's own reader of all of it: one card, a row per environment, native first, each with its own liveness —
// one side asleep must not read as the machine being away.
test("gives one card a row per environment, native first, each with its own liveness", async () => {
    const hub = createPeerHub<HostClient, { version: string }, DeviceFacts, DeviceScopes>(HOST_PEER.hub, { warn: () => {} });
    const peer = () => ({
        client: { ping: async () => ({ ok: true }) } as unknown as HostClient,
        close: () => {},
        announced: { version: "1.274.0" },
    });
    const distroKey = hostConnectionKey("rog", "wsl:archlinux");
    const detachNative = hub.attach("rog", peer());
    hub.observe("rog", { ...WINDOWS, hostname: "rog" });
    const detachDistro = hub.attach(distroKey, peer());
    hub.observe(distroKey, { ...ARCH, hostname: "rog", wsl: { distro: "archlinux" } });
    // The distro goes to sleep: still an environment of this computer, no longer online.
    detachDistro();

    const services = {
        capabilities: { list: async () => [{ kind: "device", id: "rog", config: { platform: "windows" } }] },
        hosts: { list: async () => [{ id: "rog" }, { id: distroKey }] },
        hostHub: hub,
    } as unknown as Services;
    const [machine, ...rest] = await hostSummaries(services);
    detachNative();

    expect(rest).toEqual([]);
    expect(machine?.environments.map((environment) => [environment.key, environment.online])).toEqual([
        [HOST_NATIVE_ENVIRONMENT, true],
        ["wsl:archlinux", false],
    ]);
    // What the sleeping side last said is kept, so its row can name a version and a shell rather than nothing.
    expect(machine?.environments[1]?.facts?.shell).toBe(ARCH.shell);
    expect(machine?.environments[1]?.version).toBe("1.274.0");
    // The machine's own state is the native side's: every reader that asks whether "this device" is online means that.
    expect(machine).toMatchObject({ id: "rog", platform: "windows", online: true });
    expect(machine?.facts?.shell).toBe(WINDOWS.shell);
});

// A card is a computer, so one nobody has reached yet is a computer with one environment, offline — never an empty
// list the page would have to invent a row for.
test("gives a card that has never connected its native environment anyway", async () => {
    const hub = createPeerHub<HostClient, { version: string }, DeviceFacts, DeviceScopes>(HOST_PEER.hub, { warn: () => {} });
    const services = {
        capabilities: { list: async () => [{ kind: "device", id: "omen", config: { platform: "windows" } }] },
        hosts: { list: async () => [] },
        hostHub: hub,
    } as unknown as Services;
    const [machine] = await hostSummaries(services);
    expect(machine?.environments).toEqual([{ key: HOST_NATIVE_ENVIRONMENT, online: false }]);
    expect(machine?.online).toBe(false);
});

// Hub liveness resets when the daemon restarts, so an environment that has not dialled in since must come from the
// enrollments: without this a distro drops off its own computer's page until it happens to reconnect.
test("lists an enrolled environment that has not connected since this daemon booted", async () => {
    const hub = createPeerHub<HostClient, { version: string }, DeviceFacts, DeviceScopes>(HOST_PEER.hub, { warn: () => {} });
    const services = {
        capabilities: { list: async () => [{ kind: "device", id: "rog", config: { platform: "windows" } }] },
        hosts: { list: async () => [{ id: "rog" }, { id: hostConnectionKey("rog", "wsl:archlinux") }, { id: "omen" }] },
        hostHub: hub,
    } as unknown as Services;
    const [machine] = await hostSummaries(services);
    // "omen" is another card's enrollment; an environment belongs to the card its key names, never to whichever card
    // was read first.
    expect(machine?.environments).toEqual([
        { key: HOST_NATIVE_ENVIRONMENT, online: false },
        { key: "wsl:archlinux", online: false },
    ]);
});

// What the device list addresses: one entry per environment, under its own connection key and its own platform, since
// each side runs its own agent binary and answers its own verbs.
test("turns a card's environments into one connection each", () => {
    const [native, distro, ...rest] = hostConnections([
        {
            id: "rog",
            platform: "windows",
            online: true,
            version: "1.286.0",
            environments: [
                { key: HOST_NATIVE_ENVIRONMENT, online: true, version: "1.286.0", facts: { ...WINDOWS, hostname: "rog" } },
                { key: "wsl:archlinux", online: false, version: "1.278.0", facts: { ...ARCH, hostname: "rog", wsl: { distro: "archlinux" } } },
            ],
        },
    ]);
    expect(rest).toEqual([]);
    expect(native).toMatchObject({ id: "rog", platform: "windows", online: true, version: "1.286.0" });
    // A distro is a Linux install sitting on a Windows PC: its own platform decides which shell a line is written for.
    expect(distro).toMatchObject({ id: "rog::wsl:archlinux", platform: "linux", online: false, version: "1.278.0" });
    expect(distro?.facts?.shell).toBe(ARCH.shell);
});
