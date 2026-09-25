import {
    collidesWithReservedServer,
    CONTROL_MCP_SERVERS,
    DAEMON_MCP_SERVERS,
    MCP_SERVER_MINTING_KINDS,
    RESERVED_MCP_SERVER_NAMES,
} from "./reserved-servers.js";

describe("reserved MCP server names", () => {
    test("the reserved set is exactly the daemon server rows", () => {
        expect([...RESERVED_MCP_SERVER_NAMES].toSorted()).toEqual(Object.keys(DAEMON_MCP_SERVERS).toSorted());
    });

    test("the control subset is exactly the servers whose provenance is control", () => {
        const control = Object.entries(DAEMON_MCP_SERVERS)
            .filter(([, provenance]) => provenance === "control")
            .map(([name]) => name);
        expect([...CONTROL_MCP_SERVERS].toSorted()).toEqual(control.toSorted());
        // The browser routers and the diagnostics relay carry outside content, so they are never control.
        for (const outside of ["web", "browser", "diagnostics"]) {
            expect(CONTROL_MCP_SERVERS.has(outside), outside).toBe(false);
        }
    });
});

describe("collidesWithReservedServer", () => {
    // Derived from the manifest schema's meanings: a cli card mints a server when it serves tools, a device and a
    // connected browser always do, and `mcp` is the core kind that is its own endpoint.
    test("the minting kinds are exactly the ones whose id becomes a server name", () => {
        expect([...MCP_SERVER_MINTING_KINDS].toSorted()).toEqual(["cli", "device", "mcp", "webext"]);
    });

    test("a kind whose id becomes a server name may not reuse a reserved one", () => {
        for (const kind of MCP_SERVER_MINTING_KINDS) {
            for (const name of RESERVED_MCP_SERVER_NAMES) {
                expect(collidesWithReservedServer(kind, name), `${kind}/${name}`).toBe(true);
            }
        }
    });

    test("a kind that mints no server name is free to use any id", () => {
        // Any kind outside the minting set: it names an account, a provider or infrastructure, never a turn's server.
        for (const kind of ["browser", "identity", "ssh", "docker", "extension", "agent"]) {
            for (const name of RESERVED_MCP_SERVER_NAMES) {
                expect(collidesWithReservedServer(kind, name), `${kind}/${name}`).toBe(false);
            }
        }
    });

    test("a minting kind with an ordinary id does not collide", () => {
        for (const kind of MCP_SERVER_MINTING_KINDS) {
            expect(collidesWithReservedServer(kind, "komodo")).toBe(false);
            expect(collidesWithReservedServer(kind, "my-server")).toBe(false);
        }
    });
});
