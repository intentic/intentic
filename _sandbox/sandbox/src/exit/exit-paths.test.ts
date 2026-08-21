import { expect, test } from "vitest";
import { exitControlPort, exitInterface, exitProxyPort, exitRouteTable } from "./exit-paths.js";

// The derived-name rules. Every one of these is a promise something downstream relies on, so they are pinned
// here rather than left to be rediscovered from the implementation.

test("the proxy port is derived from the id and never moves", () => {
    // THE contract of the feature: callers point at a port and keep pointing at it while the exit changes
    // country under them. A port that varied per start would break every browser profile and shell that had
    // been told about it.
    expect(exitProxyPort("berlin")).toBe(exitProxyPort("berlin"));
    expect(exitProxyPort("berlin")).not.toBe(exitProxyPort("osaka"));
    for (const id of ["berlin", "osaka", "a", "a-very-long-exit-name-indeed"]) {
        expect(exitProxyPort(id)).toBeGreaterThanOrEqual(19_000);
        expect(exitProxyPort(id)).toBeLessThan(20_000);
    }
});

test("tor's control port cannot collide with any exit's SOCKS port", () => {
    // The two ranges are a span apart, so one exit's control port can never be another's proxy port: a tor
    // that attached to the wrong control socket would take commands meant for a different country.
    for (const id of ["berlin", "osaka", "x"]) {
        expect(exitControlPort(id)).toBe(exitProxyPort(id) + 1_000);
        expect(exitControlPort(id)).toBeGreaterThanOrEqual(20_000);
    }
});

test("the routing table is per exit and never the main table", () => {
    // Table 254 is `main`. An exit writing a default route there would swallow the sandbox's own uplink, which
    // is the failure the whole subsystem is built around.
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
    // Linux caps an interface name at 15 bytes. A long id hashes rather than truncates, or two exits with the
    // same first fifteen characters would fight over one interface.
    expect(exitInterface("berlin")).toBe("xberlin");
    expect(exitInterface("berlin").length).toBeLessThanOrEqual(15);
    const long = "a-really-long-exit-name-one";
    const alsoLong = "a-really-long-exit-name-two";
    expect(exitInterface(long).length).toBeLessThanOrEqual(15);
    expect(exitInterface(long)).not.toBe(exitInterface(alsoLong));
    // And an exit's interface can never be mistaken for a vpn's, which is the bare id: the `x` prefix is what
    // keeps the two subsystems out of each other's way in one network namespace.
    expect(exitInterface("office").startsWith("x")).toBe(true);
});
