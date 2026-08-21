import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { interfaceAddress } from "../vpn/net-probe.js";
import { exitRouteTable } from "./exit-paths.js";

/* POLICY ROUTING, and the single rule that keeps this feature from breaking the sandbox.
 *
 * A geo exit is a full tunnel: everything sent into it comes out in another country. Put that in the MAIN
 * routing table and it swallows the daemon's own uplink, the model endpoint and the tunnel that makes this
 * sandbox reachable, and the symptom a user sees is the agent going silent mid-turn with no mention of a VPN
 * (IpsecVpnConfigSchema.routedNetworks documents the same trap on the vpn kind, where it is at least the
 * user's explicit choice; here it would be the happy path).
 *
 * So the default route goes into a PRIVATE table that nothing consults by default, and exactly one `ip rule`
 * points into it: traffic whose SOURCE is the tunnel's own address. Nothing acquires that source address by
 * accident, a socket has to ask for it with `localAddress`, which is what the SOCKS proxy does and what
 * nothing else in the container does. The result is an exit that is completely inert until something opts in.
 *
 * Source-address matching rather than uid ranges or firewall marks because it needs only CAP_NET_ADMIN, which
 * the vpn capability's fragment already grants. A netns would want CAP_SYS_ADMIN and would put the capability
 * in a higher privilege bracket for no gain.
 */

const exec = promisify(execFile);

// "10.2.0.2/32" → "10.2.0.2". An `ip rule from` match wants the host, not the prefix it was announced with.
export const bareAddress = (address: string): string => address.split("/")[0] ?? address;

// The tunnel's own address, waited for. An interface exists before its address does (that is the whole
// "connecting" window), so a dial that returns before the address lands is normal and this is the wait.
export const awaitInterfaceAddress = async (name: string, timeoutMs: number): Promise<string> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const address = await interfaceAddress(name);
        if (address !== undefined) {
            return bareAddress(address);
        }
        if (Date.now() >= deadline) {
            throw new Error(`${name} came up but was never assigned an address, so there is nothing to route through it`);
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
};

/* Point the exit's private table at its interface and route that interface's own source address into it.
 * `route replace` rather than `add` so a re-dial to another server in the same country is idempotent, and the
 * rules are cleared first because `ip rule add` happily stacks identical rules and a stack of them is both a
 * leak and a thing nobody can read.
 *
 * onlink + a /0 via the interface: a tunnel device is point-to-point, so there is no gateway to resolve and
 * naming the device is the whole route. */
export const installExitRoute = async (id: string, interfaceName: string, address: string): Promise<void> => {
    const table = String(exitRouteTable(id));
    await clearExitRules(id);
    await exec("ip", ["route", "replace", "default", "dev", interfaceName, "table", table]);
    await exec("ip", ["rule", "add", "from", address, "lookup", table]);
};

// Every rule pointing at this exit's table, removed. `ip rule del` takes one at a time and errors once there
// are none left, which is the loop's exit condition; the cap is a guard against an `ip` that never errors
// rather than a real expectation.
export const clearExitRules = async (id: string): Promise<void> => {
    const table = String(exitRouteTable(id));
    for (let attempt = 0; attempt < 16; attempt += 1) {
        const removed = await exec("ip", ["rule", "del", "lookup", table]).then(
            () => true,
            () => false,
        );
        if (!removed) {
            return;
        }
    }
};

// Undo installExitRoute. Tolerant throughout: "make it not be routed" is the contract, and an exit whose
// interface already vanished with its client has nothing left to remove.
export const removeExitRoute = async (id: string): Promise<void> => {
    await clearExitRules(id);
    await exec("ip", ["route", "flush", "table", String(exitRouteTable(id))]).catch(() => undefined);
};
