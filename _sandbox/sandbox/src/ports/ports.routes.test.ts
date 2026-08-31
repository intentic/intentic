import { WORKSPACE_ROOT } from "@intentic/constants";
import { portsContract, portUrl } from "@intentic/sandbox-contract";
import { portSlotsFromToken, sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { expect, test } from "vitest";
import { workspacePaths } from "../workspace/workspace.js";
import { testConfig } from "../testing.js";
import { errorCode, fakeServiceProcesses, routesClient } from "../route-testing.js";
import { createPortForwards } from "./port-forwards.js";
import { createPortsRoutes, type PortsRoutesDeps } from "./ports.routes.js";

/* The ports routes, over their own five seams.
 *
 * Split out of app.integration.test.ts: 116 tests over every route in the daemon, in one file that two agents
 * working on unrelated features collided in every time, and then stood up on `PortsRoutesDeps` rather than on
 * the whole daemon. Everything these routes can reach is in `deps` below and the compiler checks all of it, so
 * a service the daemon grows tomorrow cannot land in this file's blast radius: it is not in the type.
 *
 * The middleware the app wraps around these (bearer auth, CORS, the boot gate) is the app's, and is tested
 * there. */

const SLOT = portSlotsFromToken("tok")[0]!;

// Zone + connect token ⇒ this sandbox has a public hostname, which is what makes a forward resolvable.
const routedConfig = { ...testConfig, zone: "example.com", connectToken: "tok" };

const portsDeps = (overrides: Partial<PortsRoutesDeps> = {}): PortsRoutesDeps => ({
    config: routedConfig,
    workspace: workspacePaths(WORKSPACE_ROOT),
    portForwards: createPortForwards(portSlotsFromToken("tok"), async () => "http"),
    scanPorts: async () => [],
    ensurePreviewRoutes: async () => {},
    // The extension-process index behind each row's name: nothing installed here, so every listener is named
    // from its own command and session (port-identity.ts owns that reasoning and is tested beside it).
    files: { read: async () => undefined },
    capabilities: { list: async () => [] },
    serviceProcesses: fakeServiceProcesses(),
    ...overrides,
});

test("ports.list scans on demand, hides the daemon's own listeners, and marks forwards with their URLs", async () => {
    const portForwards = createPortForwards(portSlotsFromToken("tok"), async () => "http");
    const deps = portsDeps({
        portForwards,
        scanPorts: async () => [
            { port: 22, host: "127.0.0.1", forwardable: true },
            { port: 3000, host: "127.0.0.1", forwardable: true, pid: 7, command: "vite", cwd: `${WORKSPACE_ROOT}/app` },
            { port: 5173, host: "127.0.0.1", forwardable: true },
            { port: 8787, host: "127.0.0.1", forwardable: true },
        ],
    });
    const client = routesClient(portsContract, createPortsRoutes(deps));

    // Every row carries what it IS beside where it runs: the view renders the name and the sentence, not argv.
    const named = {
        title: "Vite dev server",
        purpose: "Running in app, outside any terminal this app can show.",
        origin: "unknown",
        kind: "workspace",
    };
    expect(await client.list()).toEqual({
        ports: [{ port: 3000, host: "127.0.0.1", forwardable: true, pid: 7, command: "vite", cwd: "/work/app", forwarded: false, ...named }],
    });

    await portForwards.forward(3000, "127.0.0.1");
    expect(await client.list()).toEqual({
        ports: [
            {
                port: 3000,
                host: "127.0.0.1",
                forwardable: true,
                pid: 7,
                command: "vite",
                cwd: `${WORKSPACE_ROOT}/app`,
                forwarded: true,
                previewUrl: portUrl(SLOT, "example.com", sandboxIdFromToken("tok")),
                ...named,
            },
        ],
    });
});

test("ports.forward maps a listener onto a slot, mints its route label, and refuses reserved/dead ports", async () => {
    const ensured: string[] = [];
    const client = routesClient(
        portsContract,
        createPortsRoutes(
            portsDeps({
                scanPorts: async () => [{ port: 3000, host: "127.0.0.1", forwardable: true, pid: 7, command: "vite" }],
                ensurePreviewRoutes: async (labels) => {
                    ensured.push(...labels);
                },
            }),
        ),
    );

    expect(await client.forward({ port: 3000 })).toEqual({ previewUrl: portUrl(SLOT, "example.com", sandboxIdFromToken("tok")) });
    expect(ensured).toEqual([`port-${SLOT}`]);
    // The daemon's own surfaces are never forwardable; a port nothing listens on is NOT_FOUND.
    expect(await errorCode(client.forward({ port: 8787 }))).toBe("BAD_REQUEST");
    expect(await errorCode(client.forward({ port: 4000 }))).toBe("NOT_FOUND");
    // Unforward frees the slot; the port reads unforwarded again.
    expect(await client.unforward({ port: 3000 })).toEqual({ ok: true });
    // No cwd and no session -> nothing to attribute it to, so the row says exactly that and files under system.
    expect((await client.list()).ports).toEqual([
        {
            port: 3000,
            host: "127.0.0.1",
            forwardable: true,
            kind: "system",
            pid: 7,
            command: "vite",
            forwarded: false,
            title: "Vite dev server",
            purpose: "Nothing in the sandbox claims this one, it answers from outside the container.",
            origin: "unknown",
        },
    ]);
});

test("ports.forward on a loopback sandbox (no zone/token) still maps the slot but returns no URL", async () => {
    const client = routesClient(
        portsContract,
        createPortsRoutes(portsDeps({ config: testConfig, scanPorts: async () => [{ port: 3000, host: "127.0.0.1", forwardable: true }] })),
    );
    expect(await client.forward({ port: 3000 })).toEqual({});
});
