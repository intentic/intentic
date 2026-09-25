import { rm } from "node:fs/promises";
import type { IntenticLine, VpnConfig, VpnLink } from "@intentic/sandbox-contract";
import type { CapabilitiesStore } from "../capabilities/capabilities-store.js";
import { restoreTunnels, type TunnelEntry, tunnelEntries, tunnelUp } from "../tunnel/tunnel-links.js";
import { upSince } from "../tunnel/tunnel-state.js";
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

// Dials one tunnel, streaming progress.
export async function* connectVpn(entry: VpnEntry, options: { readonly otp?: string | undefined } = {}): AsyncGenerator<IntenticLine> {
    const driver = vpnDrivers[entry.config.provider];
    yield* tunnelUp("vpn", await driver.missingTool(), () => driver.connect(entry.id, entry.config, options), {
        dir: vpnDir(),
        path: upMarkerPath(entry.id),
    });
}

// Drops one tunnel; an already-down tunnel counts as success, since the goal state is just "not up".
export const disconnectVpn = async (entry: VpnEntry): Promise<void> => {
    await vpnDrivers[entry.config.provider].disconnect(entry.id, entry.config);
    await rm(upMarkerPath(entry.id), { force: true });
};

// Boot restore of every auto-connect VPN; a dead gateway logs a warning rather than failing boot.
export const reconnectVpns = (
    capabilities: CapabilitiesStore,
    logger: { info: (message: string) => void; warn: (message: string) => void },
): Promise<void> =>
    restoreTunnels(capabilities, logger, "vpn", {
        automatic: (config) => config.autoConnect === "on",
        isUp: async (entry) => {
            const { state } = await vpnDrivers[entry.config.provider].probe(entry.id, entry.config);
            return state === "connected" || state === "connecting";
        },
        up: (entry) => connectVpn(entry),
        words: { done: "reconnected", failed: "could not reconnect" },
    });
