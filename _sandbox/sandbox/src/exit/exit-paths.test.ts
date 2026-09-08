import { expect, test } from "vitest";
import { exitControlPort, exitInterface, exitProxyPort, exitRouteTable } from "./exit-paths.js";

// Derived-name rules pinned here so a promise something downstream relies on isn't rediscovered from the
// implementation.

test("the proxy port is derived from the id and never moves", () => {
    expect(exitProxyPort("berlin")).toBe(exitProxyPort("berlin"));
    expect(exitProxyPort("berlin")).not.toBe(exitProxyPort("osaka"));
    for (const id of ["berlin", "osaka", "a", "a-very-long-exit-name-indeed"]) {
        expect(exitProxyPort(id)).toBeGreaterThanOrEqual(19_000);
        expect(exitProxyPort(id)).toBeLessThan(20_000);
    }
});

test("tor's control port cannot collide with any exit's SOCKS port", () => {
    for (const id of ["berlin", "osaka", "x"]) {
        expect(exitControlPort(id)).toBe(exitProxyPort(id) + 1_000);
        expect(exitControlPort(id)).toBeGreaterThanOrEqual(20_000);
    }
});

test("the routing table is per exit and never the main table", () => {
    // Table 254 is Linux's `main`; a default route written there would swallow the sandbox's own uplink.
    for (const id of ["berlin", "osaka", "tokyo", "x"]) {
        const table = exitRouteTable(id);
        expect(table).toBeGreaterThanOrEqual(100);
        expect(table).toBeLessThan(1_100);
        expect(table).not.toBe(254);
        expect(table).not.toBe(253);
        expect(table).not.toBe(255);
    }
    expect(exitRouteTable("berlin")).not.toBe(exitRouteTable("osaka"));
});

test("interface names stay inside IFNAMSIZ and never collide on a shared prefix", () => {
    // IFNAMSIZ caps a Linux interface name at 15 bytes; a long id hashes rather than truncates to avoid a collision.
    expect(exitInterface("berlin")).toBe("xberlin");
    expect(exitInterface("berlin").length).toBeLessThanOrEqual(15);
    const long = "a-really-long-exit-name-one";
    const alsoLong = "a-really-long-exit-name-two";
    expect(exitInterface(long).length).toBeLessThanOrEqual(15);
    expect(exitInterface(long)).not.toBe(exitInterface(alsoLong));
    // The `x` prefix keeps this subsystem's interfaces from colliding with the vpn subsystem's bare-id ones.
    expect(exitInterface("office").startsWith("x")).toBe(true);
});
