import { interfaceAddress } from "../tunnel/net-probe.js";
import { exitInterface, exitProxyPort } from "./exit-paths.js";
import { awaitInterfaceAddress, bareAddress, installExitRoute, removeExitRoute } from "./exit-routing.js";
import { type SocksHandle, startSocks } from "./exit-socks.js";

// The shared half of every tunnel-based provider: once an interface exists, wait for its address, route it into the
// exit's private table, and publish a SOCKS proxy bound to it. Tor needs none of this: no interface, no routing, its
// own SOCKS port, which is why it needs no container privileges.

// Not the tunnel's pushed resolver (the relay operator's own); queried from the tunnel address, so they see it.
const PUBLIC_RESOLVERS = ["1.1.1.1", "8.8.8.8", "9.9.9.9"] as const;

// Shorter than the dial timeout: by now the client already reported success, so only the address is outstanding.
const ADDRESS_TIMEOUT_MS = 30_000;

// Daemon-process memory, not read off the machine: a listening socket only exists here. After a restart the tunnel may
// run while its proxy is gone; ensureProxy re-publishes it, and proxyBound reports that gap as starting, not up.
const proxies = new Map<string, SocksHandle>();

export const proxyBound = (id: string): boolean => proxies.has(id);

// Publishes (or re-publishes) the SOCKS proxy for an interface already up; idempotent, safe for a fresh start or a
// post-restart repair. Routing reinstalls every time too, since a re-dial can hand back a different address.
export const ensureProxy = async (id: string): Promise<string> => {
    const name = exitInterface(id);
    const address = await awaitInterfaceAddress(name, ADDRESS_TIMEOUT_MS);
    await installExitRoute(id, name, address);
    if (proxies.has(id)) {
        return address;
    }
    const handle = await startSocks({
        port: exitProxyPort(id),
        localAddress: address,
        resolver: { servers: PUBLIC_RESOLVERS, localAddress: address },
    });
    proxies.set(id, handle);
    return address;
};

// Drops the proxy and routing, leaving the tunnel client to the driver: a country switch tears these down and rebuilds
// them around a new dial, while the client's lifecycle differs per provider.
export const dropProxy = async (id: string): Promise<void> => {
    await proxies.get(id)?.close();
    proxies.delete(id);
    await removeExitRoute(id);
};

// The tunnel's current address, or undefined once the interface is gone; used by a driver's `observe`.
export const tunnelAddress = async (id: string): Promise<string | undefined> => {
    const address = await interfaceAddress(exitInterface(id));
    return address === undefined ? undefined : bareAddress(address);
};

export const tunnelResolver = (address: string) => ({ servers: PUBLIC_RESOLVERS, localAddress: address });
