import { rm } from "node:fs/promises";
import type { IntenticLine, NetdiskConfig, NetdiskLink } from "@intentic/sandbox-contract";
import type { CapabilitiesStore } from "../capabilities/capabilities-store.js";
import { restoreTunnels, type TunnelEntry, tunnelEntries, tunnelUp } from "../tunnel/tunnel-links.js";
import { upSince } from "../tunnel/tunnel-state.js";
import { netdiskDrivers } from "./netdisk-drivers.js";
import { mountPoint, netdiskDir, upMarkerPath } from "./netdisk-paths.js";

// The one place the manifest (which disks exist) is joined to the machine (which are mounted); the capability card,
// CLI, apply handler and boot restore all go through these functions.

export type NetdiskEntry = TunnelEntry<NetdiskConfig>;

// One configured disk as the UI and the CLI see it: manifest intent plus whatever the kernel reports right now.
export const netdiskLink = async (entry: NetdiskEntry): Promise<NetdiskLink> => {
    const driver = netdiskDrivers[entry.config.provider];
    const probe = await driver.probe(entry.id, entry.config);
    return {
        id: entry.id,
        provider: entry.config.provider,
        state: probe.state,
        target: driver.target(entry.config),
        mountPoint: mountPoint(entry.id),
        access: entry.config.access,
        autoMount: entry.config.autoMount === "on",
        ...(probe.writable === undefined ? {} : { writable: probe.writable }),
        ...(probe.detail === undefined ? {} : { detail: probe.detail }),
        ...(probe.state === "mounted" ? { since: await upSince(upMarkerPath(entry.id)) } : {}),
    };
};

// Every configured disk with its live state, probed concurrently.
export const netdiskLinks = async (capabilities: CapabilitiesStore): Promise<NetdiskLink[]> =>
    Promise.all(tunnelEntries(await capabilities.list(), "netdisk").map((entry) => netdiskLink(entry)));

// Mounts one disk, streaming progress.
export async function* mountNetdisk(entry: NetdiskEntry): AsyncGenerator<IntenticLine> {
    const driver = netdiskDrivers[entry.config.provider];
    yield* tunnelUp("netdisk", await driver.missingTool(), () => driver.mount(entry.id, entry.config), {
        dir: netdiskDir(),
        path: upMarkerPath(entry.id),
    });
}

// Unmounts one disk; an already-unmounted disk counts as success, since the goal state is just "not mounted".
export const unmountNetdisk = async (entry: NetdiskEntry): Promise<void> => {
    await netdiskDrivers[entry.config.provider].unmount(entry.id, entry.config);
    await rm(upMarkerPath(entry.id), { force: true });
};

// Boot restore of every auto-mount disk; runs after the VPNs reconnect, since a disk behind a tunnel is unreachable
// before it.
export const remountNetdisks = (
    capabilities: CapabilitiesStore,
    logger: { info: (message: string) => void; warn: (message: string) => void },
): Promise<void> =>
    restoreTunnels(capabilities, logger, "netdisk", {
        automatic: (config) => config.autoMount === "on",
        isUp: async (entry) => (await netdiskDrivers[entry.config.provider].probe(entry.id, entry.config)).state === "mounted",
        up: (entry) => mountNetdisk(entry),
        words: { done: "mounted", failed: "could not mount" },
    });
