import { rm } from "node:fs/promises";
import { errorMessage } from "@intentic/base/errors";
import type { IntenticLine } from "@intentic/sandbox-contract/events/system-events";
import type { NetdiskConfig, NetdiskLink } from "@intentic/sandbox-contract/schemas/netdisk";
import type { CapabilitiesStore } from "../capabilities/capabilities-store.js";
import { opt } from "../opt.js";
import { restoreTunnels, type TunnelEntry, tunnelEntries, tunnelUp } from "../tunnel/tunnel-links.js";
import { upSince } from "../tunnel/tunnel-state.js";
import { netdiskDrivers } from "./netdisk-drivers.js";
import { mountPoint, netdiskDir, upMarkerPath } from "./netdisk-paths.js";
import { type NetdiskRelay, openRelay, relayTunnel, releaseRelay } from "./netdisk-relay.js";

// The one place the manifest (which disks exist) is joined to the machine (which are mounted); the capability card,
// CLI, apply handler and boot restore all go through these functions. A disk whose card names a computer to reach it
// through (`via`) mounts through that computer's tunnel (netdisk-relay.ts), which these open and let go of around the mount.

export type NetdiskEntry = TunnelEntry<NetdiskConfig>;

// How long a boot waits for the computer a disk is reached through: its agent reconnects on its own once the sandbox is
// back, usually within seconds, and a laptop opened later mounts the disk only when someone asks.
const BOOT_WAIT_MS = 3 * 60_000;

// Said of a mounted disk whose tunnel is not open: the kernel holds a mount it can no longer reach.
const relayDetail = async (entry: NetdiskEntry, relay: NetdiskRelay): Promise<string | undefined> => {
    if (entry.config.via === undefined) {
        return undefined;
    }
    const tunnel = await relayTunnel(entry.id, relay);
    return tunnel.open ? undefined : `mounted through ${entry.config.via}, but its tunnel is closed: unmount and mount it again`;
};

// One configured disk as the UI and the CLI see it: manifest intent plus whatever the kernel reports right now.
export const netdiskLink = async (entry: NetdiskEntry, relay: NetdiskRelay): Promise<NetdiskLink> => {
    const driver = netdiskDrivers[entry.config.provider];
    const probe = await driver.probe(entry.id, entry.config);
    const detail = probe.detail ?? (probe.state === "mounted" ? await relayDetail(entry, relay) : undefined);
    return {
        id: entry.id,
        provider: entry.config.provider,
        state: probe.state,
        target: driver.target(entry.config),
        mountPoint: mountPoint(entry.id),
        access: entry.config.access,
        ...opt("via", entry.config.via),
        autoMount: entry.config.autoMount === "on",
        ...opt("writable", probe.writable),
        ...opt("detail", detail),
        ...(probe.state === "mounted" ? { since: await upSince(upMarkerPath(entry.id)) } : {}),
    };
};

// Every configured disk with its live state, probed concurrently.
export const netdiskLinks = async (capabilities: CapabilitiesStore, relay: NetdiskRelay): Promise<NetdiskLink[]> =>
    Promise.all(tunnelEntries(await capabilities.list(), "netdisk").map((entry) => netdiskLink(entry, relay)));

// Through a computer: its tunnel first (standing when the kernel already holds the mount, so it reopens on the port the
// mount dials even while the computer is away), then the mount through it. A mount that fails lets a tunnel it opened go.
async function* mountThrough(entry: NetdiskEntry, via: string, relay: NetdiskRelay): AsyncGenerator<IntenticLine> {
    const driver = netdiskDrivers[entry.config.provider];
    const mounted = (await driver.probe(entry.id, entry.config)).state === "mounted";
    const port = await openRelay(entry.id, { device: via, host: entry.config.server }, relay, mounted);
    try {
        yield* driver.mount(entry.id, entry.config, { address: "127.0.0.1", port, through: via });
    } catch (error) {
        const { failure } = await relayTunnel(entry.id, relay);
        await releaseRelay(entry.id, relay);
        throw failure === undefined ? error : new Error(`${errorMessage(error)}\n${via} said: ${failure}`, { cause: error });
    }
}

// Mounts one disk, streaming progress.
export async function* mountNetdisk(entry: NetdiskEntry, relay: NetdiskRelay): AsyncGenerator<IntenticLine> {
    const driver = netdiskDrivers[entry.config.provider];
    const { via } = entry.config;
    yield* tunnelUp("netdisk", await driver.missingTool(), () => (via === undefined ? driver.mount(entry.id, entry.config) : mountThrough(entry, via, relay)), {
        dir: netdiskDir(),
        path: upMarkerPath(entry.id),
    });
}

// Unmounts one disk; an already-unmounted disk counts as success, since the goal state is just "not mounted". The tunnel
// it mounted through goes with it, whatever its card says now: an edit that dropped `via` still closes the old one.
export const unmountNetdisk = async (entry: NetdiskEntry, relay: NetdiskRelay): Promise<void> => {
    await netdiskDrivers[entry.config.provider].unmount(entry.id, entry.config);
    await rm(upMarkerPath(entry.id), { force: true });
    await releaseRelay(entry.id, relay);
};

interface RestoreLogger {
    info: (message: string) => void;
    warn: (message: string) => void;
}

// Boot restore of one disk reached through a computer. One the kernel still holds (the daemon restarted, the container
// did not) gets its tunnel back at once, standing; an auto-mount one waits for its computer to reconnect, then mounts.
const restoreThrough = async (entry: NetdiskEntry, via: string, relay: NetdiskRelay, logger: RestoreLogger): Promise<void> => {
    try {
        const probe = await netdiskDrivers[entry.config.provider].probe(entry.id, entry.config);
        if (probe.state === "mounted") {
            await openRelay(entry.id, { device: via, host: entry.config.server }, relay, true);
            logger.info(`netdisk ${entry.id}: its tunnel through ${via} is open again`);
            return;
        }
        if (entry.config.autoMount !== "on" || probe.state === "unavailable") {
            return;
        }
        if (!(await relay.whenOnline(via, BOOT_WAIT_MS))) {
            logger.warn(`netdisk ${entry.id}: ${via} did not connect within ${BOOT_WAIT_MS / 60_000} minutes; mount it once ${via} is back`);
            return;
        }
        for await (const line of mountNetdisk(entry, relay)) {
            void line;
        }
        logger.info(`netdisk ${entry.id}: mounted through ${via}`);
    } catch (error) {
        logger.warn(`netdisk ${entry.id}: could not mount through ${via}: ${errorMessage(error)}`);
    }
};

// Boot restore of every auto-mount disk; runs after the VPNs reconnect, since a disk behind a tunnel is unreachable
// before it. A disk reached through a computer waits for that computer instead, each on its own, so one laptop that
// stays shut holds up no other disk.
export const remountNetdisks = async (capabilities: CapabilitiesStore, logger: RestoreLogger, relay: NetdiskRelay): Promise<void> => {
    const through = tunnelEntries(await capabilities.list(), "netdisk").flatMap((entry) => {
        const { via } = entry.config;
        return via === undefined ? [] : [restoreThrough(entry, via, relay, logger)];
    });
    await restoreTunnels(capabilities, logger, "netdisk", {
        automatic: (config) => config.autoMount === "on" && config.via === undefined,
        isUp: async (entry) => (await netdiskDrivers[entry.config.provider].probe(entry.id, entry.config)).state === "mounted",
        up: (entry) => mountNetdisk(entry, relay),
        words: { done: "mounted", failed: "could not mount" },
    });
    await Promise.all(through);
};
