import { rm } from "node:fs/promises";
import type { VpnConfig, WireguardVpnConfig } from "@intentic/sandbox-contract/schemas/vpn";
import { activeResolvers, interfaceAddress, interfaceRoutes } from "../tunnel/net-probe.js";
import { wireguardDial, wireguardDrop, wireguardEndpoint, wireguardMissing, wireguardUp, writeWireguardConf } from "../tunnel/wireguard-tools.js";
import type { VpnDriver, VpnProbe } from "./vpn-driver.js";
import { interfaceName, wireguardConfPath } from "./vpn-paths.js";

// WireGuard: the pasted .conf is the whole connection. wg-quick derives the interface from the file name, so
// the conf is written as <interface>.conf and dialled by path (tunnel/wireguard-tools.ts).

const config = (raw: VpnConfig): WireguardVpnConfig => raw as WireguardVpnConfig;

export const wireguardDriver: VpnDriver = {
    gateway: (raw) => wireguardEndpoint(config(raw).config),
    write: async (id, raw) => {
        await writeWireguardConf(wireguardConfPath(id), config(raw).config);
    },
    erase: async (id) => {
        await rm(wireguardConfPath(id), { force: true });
    },
    missingTool: wireguardMissing,
    async *connect(id, raw) {
        const name = interfaceName(id);
        if (await wireguardUp(name)) {
            yield { kind: "log", message: `${id} is already up on ${name}.` };
            return;
        }
        // Re-write before dialling so a conf edited through /secrets takes effect on the next connect.
        await wireguardDriver.write(id, raw);
        yield { kind: "log", message: `Bringing up WireGuard interface ${name}…` };
        await wireguardDial(wireguardConfPath(id));
        yield { kind: "log", message: `Connected ${id}. Traffic matching the peer's AllowedIPs now rides the tunnel.` };
    },
    disconnect: async (id) => {
        await wireguardDrop(wireguardConfPath(id));
    },
    probe: async (id): Promise<VpnProbe> => {
        const name = interfaceName(id);
        if (!(await wireguardUp(name))) {
            return { state: (await wireguardMissing()) === undefined ? "disconnected" : "unavailable" };
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
