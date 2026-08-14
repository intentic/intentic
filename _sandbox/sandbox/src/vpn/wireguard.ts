import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { VpnConfig, WireguardVpnConfig } from "@intentic/sandbox-contract";
import { activeResolvers, interfaceAddress, interfaceRoutes, toolMissing } from "./net-probe.js";
import type { VpnDriver, VpnProbe } from "./vpn-driver.js";
import { interfaceName, vpnDir, wireguardConfPath } from "./vpn-paths.js";

// WireGuard: the pasted .conf is the whole connection. wg-quick derives the interface from the file name, so
// the conf is written as <interface>.conf and dialled by path — nothing ever has to live in /etc/wireguard.
// A dial is synchronous (wg-quick returns once the interface is configured), so there is no client process to
// supervise: the interface IS the tunnel, and `wg show` is the liveness answer.

const exec = promisify(execFile);
const config = (raw: VpnConfig): WireguardVpnConfig => raw as WireguardVpnConfig;

// The [Peer] Endpoint, for display. Parsed leniently — a conf with no endpoint (a peer that only ever dials in)
// is legal, so a missing gateway label is not worth failing an add over.
const wireguardEndpoint = (conf: string): string | undefined => /^\s*Endpoint\s*=\s*(\S+)/im.exec(conf)?.[1];

// `wg show <if>` succeeds only for an existing WireGuard interface.
const tunnelUp = async (name: string): Promise<boolean> =>
    exec("wg", ["show", name]).then(
        () => true,
        () => false,
    );

export const wireguardDriver: VpnDriver = {
    gateway: (raw) => wireguardEndpoint(config(raw).config),
    write: async (id, raw) => {
        await mkdir(vpnDir(), { recursive: true, mode: 0o700 });
        const conf = config(raw).config;
        // The conf holds the interface's private key — never group/world readable.
        await writeFile(wireguardConfPath(id), conf.endsWith("\n") ? conf : `${conf}\n`, { mode: 0o600 });
    },
    erase: async (id) => {
        await rm(wireguardConfPath(id), { force: true });
    },
    // wireguard-tools and the resolvconf its DNS= handling shells out to both arrive with the capability's
    // image fragment; wg-quick is the one that must exist to dial.
    missingTool: async () => ((await toolMissing("wg-quick", ["--help"])) ? "wg-quick" : undefined),
    connect: async function* (id, raw) {
        const name = interfaceName(id);
        if (await tunnelUp(name)) {
            yield { kind: "log", message: `${id} is already up on ${name}.` };
            return;
        }
        // Re-write before dialling so a conf edited through /secrets takes effect on the next connect.
        await wireguardDriver.write(id, raw);
        yield { kind: "log", message: `Bringing up WireGuard interface ${name}…` };
        // Only the conf PATH reaches the command line — the keys stay in the 0600 file, never in argv or a log.
        await exec("wg-quick", ["up", wireguardConfPath(id)]);
        yield { kind: "log", message: `Connected ${id}. Traffic matching the peer's AllowedIPs now rides the tunnel.` };
    },
    // Already down, no conf yet, no wg-quick installed — all reduce to "not up", which is the goal state.
    disconnect: async (id) => {
        await exec("wg-quick", ["down", wireguardConfPath(id)]).catch(() => undefined);
    },
    probe: async (id): Promise<VpnProbe> => {
        const name = interfaceName(id);
        if (!(await tunnelUp(name))) {
            return { state: (await toolMissing("wg-quick", ["--help"])) ? "unavailable" : "disconnected" };
        }
        return {
            state: "connected",
            interface: name,
            address: await interfaceAddress(name),
            routes: await interfaceRoutes(name),
            dns: await activeResolvers(),
        };
    },
};
