import type { Capability } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import type { CapabilitiesStore } from "../capabilities/capabilities-store.js";
import { checks } from "./invariant.js";

/* The routing check is the safety property of the entire subsystem, so it is exercised against real `ip route`
 * output rather than a shape someone believed it had. The table below is a genuine `ip route show table main`
 * from a sandbox: a default route, the container network, and, in the violating case, an exit that leaked. */

const MAIN_TABLE = `default via 172.17.0.1 dev eth0
172.17.0.0/16 dev eth0 proto kernel scope link src 172.17.0.2
`;

const store = (capabilities: Capability[]): CapabilitiesStore => ({ list: async () => capabilities }) as unknown as CapabilitiesStore;

const exit = (id: string): Capability => ({ id, kind: "exit", config: { provider: "tor", autoStart: "off" } }) as Capability;

const run = async (deps: Parameters<typeof checks>[0], name: string): Promise<string | undefined> => {
    const check = checks(deps).find((candidate) => candidate.name === name);
    if (check === undefined) {
        throw new Error(`no check named ${name}`);
    }
    let failure: string | undefined;
    // `fail` throws by contract (the registry catches it), so the call is wrapped rather than the result
    // inspected: a check reads as a sequence of guards, and `run` may be sync or async.
    try {
        await check.run({
            moment: "sweep",
            fail: (message: string) => {
                failure = message;
                throw new Error(message);
            },
        });
    } catch {
        // The throw is how a violation is reported; the message was captured above.
    }
    return failure;
};

test("a clean main table is not a violation", async () => {
    const failure = await run({ capabilities: store([exit("berlin")]), mainRoutes: async () => MAIN_TABLE }, "no-exit-route-in-the-main-table");
    expect(failure).toBeUndefined();
});

test("an exit that leaked into the main table is reported, with what it costs", async () => {
    /* THE failure this subsystem exists to prevent, and the reason it is worth a runtime check rather than
     * trusting the drivers: `route-nopull` and `Table = off` are properties of code that can be edited, and a
     * provider changing what it pushes can produce this with nothing here changing at all. */
    const leaked = `${MAIN_TABLE}default dev xberlin scope link\n`;
    const failure = await run({ capabilities: store([exit("berlin")]), mainRoutes: async () => leaked }, "no-exit-route-in-the-main-table");
    expect(failure).toMatch(/xberlin \(exit "berlin"\)/);
    // The message has to say what breaks, not just what was found: a route in table main is not obviously fatal
    // to whoever reads the log line at 3am.
    expect(failure).toMatch(/uplink/);
});

test("an interface belonging to something else is not read as an exit's", async () => {
    // `xberlin` is the exit's derived name; a VPN's interface is the bare id, and a coincidence like `wg0`
    // must not be attributed here. The word boundary is what stops a partial match reporting a phantom.
    const other = `${MAIN_TABLE}10.0.0.0/8 dev wg0 scope link\n192.168.0.0/16 dev xberlinX scope link\n`;
    expect(await run({ capabilities: store([exit("berlin")]), mainRoutes: async () => other }, "no-exit-route-in-the-main-table")).toBeUndefined();
});

test("no exits configured, or no readable routing table, is silence rather than a false alarm", async () => {
    // A sandbox that has never had an exit must not see this check at all, and one where `ip` is unavailable
    // has nothing to observe: a check that reported either would be noise on every sandbox in the fleet.
    expect(
        await run({ capabilities: store([]), mainRoutes: async () => `${MAIN_TABLE}default dev xberlin\n` }, "no-exit-route-in-the-main-table"),
    ).toBeUndefined();
    expect(await run({ capabilities: store([exit("berlin")]), mainRoutes: async () => "" }, "no-exit-route-in-the-main-table")).toBeUndefined();
});

test("both checks can fail, and neither throws at the daemon", () => {
    // The registry's own rules: a check that cannot report is a green light with no subject, and a check that
    // throws on its own account takes a turn down with it.
    const registered = checks({ capabilities: store([]) });
    expect(registered.map((check) => check.name)).toEqual(["no-exit-route-in-the-main-table", "up-exits-come-out-where-they-were-asked"]);
    expect(registered.every((check) => check.on.length > 0)).toBe(true);
    // The routing check runs at boot too: a route left by a previous life of this container would break the
    // daemon's uplink before anything else noticed.
    expect(registered[0]?.on).toContain("boot");
});
