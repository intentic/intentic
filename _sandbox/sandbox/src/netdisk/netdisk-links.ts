import { rm } from "node:fs/promises";
import { errorMessage } from "@intentic/base/errors";
import type { IntenticLine, NetdiskConfig, NetdiskLink } from "@intentic/sandbox-contract";
import type { CapabilitiesStore } from "../capabilities/capabilities-store.js";
import { notCarriedYet, type TunnelEntry, tunnelEntries } from "../tunnel/tunnel-links.js";
import { markUp, upSince } from "../tunnel/tunnel-state.js";
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

// Mounts one disk, streaming progress; the up marker is written only after the driver reports success, so it never
// contradicts a probe.
export async function* mountNetdisk(entry: NetdiskEntry): AsyncGenerator<IntenticLine> {
    const driver = netdiskDrivers[entry.config.provider];
    const missing = await driver.missingTool();
    if (missing !== undefined) {
        throw notCarriedYet(missing, "netdisk");
    }
    yield* driver.mount(entry.id, entry.config);
    await markUp(netdiskDir(), upMarkerPath(entry.id));
}

// Unmounts one disk; an already-unmounted disk counts as success, since the goal state is just "not mounted".
export const unmountNetdisk = async (entry: NetdiskEntry): Promise<void> => {
    await netdiskDrivers[entry.config.provider].unmount(entry.id, entry.config);
    await rm(upMarkerPath(entry.id), { force: true });
};

// Boot restore: mounts die with the container while the manifest survives on /work, so every auto-mount disk is
// re-mounted. Runs after the VPNs reconnect, since a disk behind a tunnel is unreachable before it. Best-effort; a dead
// server logs a warning rather than failing boot.
export const remountNetdisks = async (
    capabilities: CapabilitiesStore,
    logger: { info: (message: string) => void; warn: (message: string) => void },
): Promise<void> => {
    for (const entry of tunnelEntries(await capabilities.list(), "netdisk")) {
        if (entry.config.autoMount !== "on") {
            continue;
        }
        // Probed inside the try: one disk whose state can't be read must not strand every one after it.
        try {
            const probe = await netdiskDrivers[entry.config.provider].probe(entry.id, entry.config);
            if (probe.state === "mounted") {
                continue;
            }
            for await (const line of mountNetdisk(entry)) {
                void line;
            }
            logger.info(`netdisk ${entry.id}: mounted`);
        } catch (error) {
            logger.warn(`netdisk ${entry.id}: could not mount: ${errorMessage(error)}`);
        }
    }
};
