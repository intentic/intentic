import { rm } from "node:fs/promises";
import { errorMessage } from "@intentic/base/errors";
import type { IntenticLine, VpnConfig, VpnLink } from "@intentic/sandbox-contract";
import type { CapabilitiesStore } from "../capabilities/capabilities-store.js";
import { notCarriedYet, type TunnelEntry, tunnelEntries } from "../tunnel/tunnel-links.js";
import { markUp, upSince } from "../tunnel/tunnel-state.js";
import { vpnDrivers } from "./vpn-drivers.js";
import { upMarkerPath, vpnDir } from "./vpn-paths.js";

// The one place the manifest (which VPNs exist) is joined to the machine (which are up); the capability card, CLI,
// apply handler and boot restore all go through these three functions.

export type VpnEntry = TunnelEntry<VpnConfig>;

// One configured VPN as the UI and the CLI see it: manifest intent plus whatever the OS reports right now.
export const vpnLink = async (entry: VpnEntry): Promise<VpnLink> => {
    const driver = vpnDrivers[entry.config.provider];
    const probe = await driver.probe(entry.id, entry.config);
    const gateway = driver.gateway(entry.config);
    return {
        id: entry.id,
        provider: entry.config.provider,
        state: probe.state,
        autoConnect: entry.config.autoConnect === "on",
        routes: [...(probe.routes ?? [])],
        // Only a connected link's resolvers are its own; /etc/resolv.conf is global, so a down tunnel gets none.
        dns: probe.state === "connected" ? [...(probe.dns ?? [])] : [],
        ...(gateway === undefined ? {} : { gateway }),
        ...(probe.interface === undefined ? {} : { interface: probe.interface }),
        ...(probe.address === undefined ? {} : { address: probe.address }),
        ...(probe.detail === undefined ? {} : { detail: probe.detail }),
        ...(probe.state === "connected" ? { since: await upSince(upMarkerPath(entry.id)) } : {}),
    };
};

// Every configured VPN with its live state, probed concurrently.
export const vpnLinks = async (capabilities: CapabilitiesStore): Promise<VpnLink[]> =>
    Promise.all(tunnelEntries(await capabilities.list(), "vpn").map((entry) => vpnLink(entry)));

// Dials one tunnel, streaming progress; the up marker is written only after the driver reports success, so it never
// contradicts a probe.
export async function* connectVpn(entry: VpnEntry, options: { readonly otp?: string | undefined } = {}): AsyncGenerator<IntenticLine> {
    const driver = vpnDrivers[entry.config.provider];
    const missing = await driver.missingTool();
    if (missing !== undefined) {
        throw notCarriedYet(missing, "vpn");
    }
    yield* driver.connect(entry.id, entry.config, options);
    await markUp(vpnDir(), upMarkerPath(entry.id));
}

// Drops one tunnel; an already-down tunnel counts as success, since the goal state is just "not up".
export const disconnectVpn = async (entry: VpnEntry): Promise<void> => {
    await vpnDrivers[entry.config.provider].disconnect(entry.id, entry.config);
    await rm(upMarkerPath(entry.id), { force: true });
};

// Boot restore: tunnels die with the container while the manifest survives on /work, so every auto-connect VPN is
// re-dialled. Best-effort; a dead gateway logs a warning rather than failing boot.
export const reconnectVpns = async (
    capabilities: CapabilitiesStore,
    logger: { info: (message: string) => void; warn: (message: string) => void },
): Promise<void> => {
    for (const entry of tunnelEntries(await capabilities.list(), "vpn")) {
        if (entry.config.autoConnect !== "on") {
            continue;
        }
        const probe = await vpnDrivers[entry.config.provider].probe(entry.id, entry.config);
        if (probe.state === "connected" || probe.state === "connecting") {
            continue;
        }
        try {
            for await (const line of connectVpn(entry)) {
                void line;
            }
            logger.info(`vpn ${entry.id}: reconnected`);
        } catch (error) {
            logger.warn(`vpn ${entry.id}: could not reconnect: ${errorMessage(error)}`);
        }
    }
};
