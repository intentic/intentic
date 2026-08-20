import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import type { Capability, IntenticLine, VpnConfig, VpnLink } from "@intentic/sandbox-contract";
import type { CapabilitiesStore } from "../capabilities/capabilities-store.js";
import { vpnDrivers } from "./vpn-drivers.js";
import { upMarkerPath, vpnDir } from "./vpn-paths.js";

// The one place the manifest ("which VPNs exist") is joined to the machine ("which are up"). Everything that
// can dial a tunnel, the Sandbox ▸ Status card, the `vpn` CLI on the agent's PATH, the capability handler's
// apply, and the boot restore, goes through these three functions, so there is exactly one definition of what
// connecting means and no surface can drift from another.

// A vpn-kind capability, narrowed. The manifest is a discriminated union over `kind`, so this is the one cast
// the module needs and every driver below can take a VpnConfig without re-checking.
export interface VpnEntry {
    readonly id: string;
    readonly config: VpnConfig;
}

const vpnEntries = (capabilities: readonly Capability[]): VpnEntry[] =>
    capabilities.flatMap((capability) => (capability.kind === "vpn" ? [{ id: capability.id, config: capability.config }] : []));

// Epoch ms this tunnel came up, from the marker written on a successful dial. ADVISORY: liveness always comes
// from the driver's probe, so a tunnel raised outside the daemon shows no uptime rather than a wrong state.
const upSince = async (id: string): Promise<number | undefined> => {
    const info = await stat(upMarkerPath(id)).catch(() => undefined);
    return info?.mtimeMs;
};

const markUp = async (id: string): Promise<void> => {
    await mkdir(vpnDir(), { recursive: true, mode: 0o700 });
    await writeFile(upMarkerPath(id), "", { mode: 0o600 });
};

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
        // Only a connected link's resolvers are its own — /etc/resolv.conf is global, so attributing it to a
        // tunnel that is down would be a lie.
        dns: probe.state === "connected" ? [...(probe.dns ?? [])] : [],
        ...(gateway === undefined ? {} : { gateway }),
        ...(probe.interface === undefined ? {} : { interface: probe.interface }),
        ...(probe.address === undefined ? {} : { address: probe.address }),
        ...(probe.detail === undefined ? {} : { detail: probe.detail }),
        ...(probe.state === "connected" ? { since: await upSince(entry.id) } : {}),
    };
};

// Every configured VPN with its live state, probed concurrently (the capabilities list's precedent).
export const vpnLinks = async (capabilities: CapabilitiesStore): Promise<VpnLink[]> =>
    Promise.all(vpnEntries(await capabilities.list()).map((entry) => vpnLink(entry)));

// Dial one tunnel, streaming the client's progress. The up marker is written only after the driver reports
// success, so its presence never contradicts a probe.
export async function* connectVpn(entry: VpnEntry, options: { readonly otp?: string | undefined } = {}): AsyncGenerator<IntenticLine> {
    const driver = vpnDrivers[entry.config.provider];
    const missing = await driver.missingTool();
    if (missing !== undefined) {
        throw new Error(
            `This sandbox doesn't carry ${missing} yet. Rebuild it from the Sandbox ▸ Environment card — the VPN capability's image fragment installs it, and an auto-connect tunnel dials itself once the sandbox restarts.`,
        );
    }
    yield* driver.connect(entry.id, entry.config, options);
    await markUp(entry.id);
}

// Drop one tunnel. Tolerant by contract: the goal state is "not up", so an already-down tunnel is a success.
export const disconnectVpn = async (entry: VpnEntry): Promise<void> => {
    await vpnDrivers[entry.config.provider].disconnect(entry.id, entry.config);
    await rm(upMarkerPath(entry.id), { force: true });
};

// Boot restore: tunnels die with the container while the manifest survives on /work, so main.ts re-dials every
// VPN the user left on auto-connect. Best-effort, a dead gateway must not take the daemon down; the failure
// lands in the link's state and the daemon log.
export const reconnectVpns = async (
    capabilities: CapabilitiesStore,
    logger: { info: (message: string) => void; warn: (message: string) => void },
): Promise<void> => {
    for (const entry of vpnEntries(await capabilities.list())) {
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
            logger.warn(`vpn ${entry.id}: could not reconnect: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
};
