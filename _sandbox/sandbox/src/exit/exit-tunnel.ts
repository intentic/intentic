import { interfaceAddress } from "../vpn/net-probe.js";
import { exitInterface, exitProxyPort } from "./exit-paths.js";
import { awaitInterfaceAddress, bareAddress, installExitRoute, removeExitRoute } from "./exit-routing.js";
import { type SocksHandle, startSocks } from "./exit-socks.js";

/* THE SHARED HALF OF EVERY TUNNEL-BASED PROVIDER. VPN Gate and WireGuard differ entirely in how they dial and
 * not at all in what happens once an interface exists: wait for its address, route that address into the
 * exit's private table, and publish a SOCKS proxy that binds outbound sockets to it.
 *
 * Tor uses none of this. It has no interface, no routing and its own SOCKS port, which is exactly why it is
 * the provider that needs no container privileges.
 */

// Public resolvers, deliberately not the ones the tunnel pushes. A volunteer relay's own resolver is run by
// the volunteer, and adopting it hands them every hostname the exit is asked for on top of the traffic they
// already carry. These are queried FROM the tunnel address, so they see the exit, not this sandbox.
const PUBLIC_RESOLVERS = ["1.1.1.1", "8.8.8.8", "9.9.9.9"] as const;

// A tunnel that has not been assigned an address by now is not coming up. Shorter than the dial timeout on
// purpose: by this point the client has already reported success, so the address is the only thing outstanding.
const ADDRESS_TIMEOUT_MS = 30_000;

/* Live proxies, by exit id. Daemon-process memory, and the one piece of this subsystem that is NOT read off
 * the machine, because a listening socket genuinely lives in this process and nowhere else.
 *
 * The consequence is handled rather than ignored: after a daemon restart the tunnel client may still be
 * running while its proxy is gone. `ensureProxy` is idempotent so the boot restore can re-publish it without
 * touching the tunnel, and `proxyBound` is what lets a probe report that gap as "starting" instead of
 * claiming an exit is up when nothing can reach it. */
const proxies = new Map<string, SocksHandle>();

export const proxyBound = (id: string): boolean => proxies.has(id);

/* Publish (or re-publish) the SOCKS proxy for an exit whose interface is already up. Idempotent: called on an
 * exit that already has one, it leaves it alone, which is what makes it safe for both a fresh start and a
 * post-restart repair. The routing is re-installed each time because it is equally idempotent and because a
 * re-dial to another server can hand back a different tunnel address. */
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

// Drop the proxy and the routing, leaving the tunnel client itself to the driver. Split that way because a
// country switch tears these down and puts them straight back up around a new dial, while the client's
// lifecycle differs per provider.
export const dropProxy = async (id: string): Promise<void> => {
    await proxies.get(id)?.close();
    proxies.delete(id);
    await removeExitRoute(id);
};

// The tunnel's current address, or undefined when the interface is gone. Used by the drivers' `observe`,
// which asks the outside world what it sees from exactly this address.
export const tunnelAddress = async (id: string): Promise<string | undefined> => {
    const address = await interfaceAddress(exitInterface(id));
    return address === undefined ? undefined : bareAddress(address);
};

export const tunnelResolver = (address: string) => ({ servers: PUBLIC_RESOLVERS, localAddress: address });
