import type { Capability } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import type { CapabilitiesStore } from "../capabilities/capabilities-store.js";
import { checks } from "./invariant.js";

// The routing check is the safety property of the subsystem, tested against real `ip route show table main` output, not
// an assumed shape.

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
    // `fail` throws by contract (the registry catches it); wrapped here since a check reads as a sequence of guards.
    try {
        await check.run({
            moment: "sweep",
            fail: (message: string) => {
                failure = message;
                throw new Error(message);
            },
        });
    } catch {
        // The throw reports the violation; the message was already captured above.
    }
    return failure;
};

test("a clean main table is not a violation", async () => {
    const failure = await run({ capabilities: store([exit("berlin")]), mainRoutes: async () => MAIN_TABLE }, "no-exit-route-in-the-main-table");
    expect(failure).toBeUndefined();
});

test("an exit that leaked into the main table is reported, with what it costs", async () => {
    const leaked = `${MAIN_TABLE}default dev xberlin scope link\n`;
    const failure = await run({ capabilities: store([exit("berlin")]), mainRoutes: async () => leaked }, "no-exit-route-in-the-main-table");
    expect(failure).toMatch(/xberlin \(exit "berlin"\)/);
    expect(failure).toMatch(/uplink/);
});

test("an interface belonging to something else is not read as an exit's", async () => {
    // `xberlin` is the exit's derived name; a bare vpn id or `xberlinX` must not match via a partial regex.
    const other = `${MAIN_TABLE}10.0.0.0/8 dev wg0 scope link\n192.168.0.0/16 dev xberlinX scope link\n`;
    expect(await run({ capabilities: store([exit("berlin")]), mainRoutes: async () => other }, "no-exit-route-in-the-main-table")).toBeUndefined();
});

test("no exits configured, or no readable routing table, is silence rather than a false alarm", async () => {
    expect(
        await run({ capabilities: store([]), mainRoutes: async () => `${MAIN_TABLE}default dev xberlin\n` }, "no-exit-route-in-the-main-table"),
    ).toBeUndefined();
    expect(await run({ capabilities: store([exit("berlin")]), mainRoutes: async () => "" }, "no-exit-route-in-the-main-table")).toBeUndefined();
});

test("both checks can fail, and neither throws at the daemon", () => {
    // A check with no `on` triggers would never run: a green light with no subject to report on.
    const registered = checks({ capabilities: store([]) });
    expect(registered.map((check) => check.name)).toEqual(["no-exit-route-in-the-main-table", "up-exits-come-out-where-they-were-asked"]);
    expect(registered.every((check) => check.on.length > 0)).toBe(true);
    // The routing check runs at boot too: a route left by a previous container life could break the uplink first.
    expect(registered[0]?.on).toContain("boot");
});
