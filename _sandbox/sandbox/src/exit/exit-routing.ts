import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pollUntil } from "@intentic/base/async";
import { interfaceAddress } from "../tunnel/net-probe.js";
import { exitRouteTable } from "./exit-paths.js";

// A geo exit is a full tunnel; routing it into the MAIN table would swallow the daemon's own uplink, silently. The
// default route goes into a private table, reached only by traffic whose source is the tunnel's own address
// (`localAddress`), acquired only by asking. Source-address matching, not uid ranges, since it needs only
// CAP_NET_ADMIN.

const exec = promisify(execFile);

// "10.2.0.2/32" -> "10.2.0.2"; `ip rule from` wants the host, not the announced prefix.
export const bareAddress = (address: string): string => address.split("/")[0] ?? address;

// Waits for the tunnel's own address: an interface exists before its address does, so a dial returning first is normal.
export const awaitInterfaceAddress = async (name: string, timeoutMs: number): Promise<string> => {
    let address: string | undefined;
    await pollUntil(
        async () => {
            address = await interfaceAddress(name);
            return address !== undefined;
        },
        { intervalMs: 250, timeoutMs },
    );
    if (address === undefined) {
        throw new Error(`${name} came up but was never assigned an address, so there is nothing to route through it`);
    }
    return bareAddress(address);
};

// `route replace`, not `add`, so a re-dial to another server is idempotent; rules are cleared first since `ip rule add`
// stacks duplicates. The interface is point-to-point, so naming it is the whole route, no gateway to resolve.
export const installExitRoute = async (id: string, interfaceName: string, address: string): Promise<void> => {
    const table = String(exitRouteTable(id));
    await clearExitRules(id);
    await exec("ip", ["route", "replace", "default", "dev", interfaceName, "table", table]);
    await exec("ip", ["rule", "add", "from", address, "lookup", table]);
};

// `ip rule del` takes one rule at a time and errors once none remain, which is the loop's real exit condition; the
// attempt cap only guards an `ip` that never errors.
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

// Tolerant throughout: an exit whose interface already vanished with its client has nothing left to remove.
export const removeExitRoute = async (id: string): Promise<void> => {
    await clearExitRules(id);
    await exec("ip", ["route", "flush", "table", String(exitRouteTable(id))]).catch(() => undefined);
};
