import { rmSync } from "node:fs";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { portsContract, portUrl } from "@intentic/sandbox-contract";
import { portSlotsFromToken, sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { workspacePaths } from "../workspace/workspace.js";
import { memoryFleet, testConfig } from "../testing.js";
import { errorCode, routesClient } from "../harness/route-client.testing.js";
import { fakeServiceProcesses } from "../processes/processes-slice.testing.js";
import { handJobOver, openBackgroundJob, portJobOf } from "../agent/tools/jobs/background-jobs.js";
import { createPortForwards } from "./port-forwards.js";
import { createPortsRoutes, type PortsRoutesDeps } from "./ports.routes.js";

// The ports routes over PortsRoutesDeps; anything the routes can reach is in `deps` below, compiler-checked. Middleware
// (auth, CORS, boot gate) is the app's and is tested there.

const SLOT = portSlotsFromToken("tok")[0]!;

// Zone plus connect token gives this sandbox a public hostname, which makes a forward resolvable.
const routedConfig = { ...testConfig, zone: "example.com", connectToken: "tok" };

const portsDeps = (overrides: Partial<PortsRoutesDeps> = {}): PortsRoutesDeps => ({
    config: routedConfig,
    workspace: workspacePaths(WORKSPACE_ROOT),
    portForwards: createPortForwards(portSlotsFromToken("tok"), async () => "http"),
    scanPorts: async () => [],
    // Nothing installed here, so every listener is named from its own command and session alone.
    files: { read: async () => undefined },
    capabilities: { list: async () => [] },
    serviceProcesses: fakeServiceProcesses(),
    // No conversation has left a job running here, so no port is claimed by one.
    jobOn: () => undefined,
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

    // Every row carries its name and purpose beside where it runs; the view never renders raw argv.
    const named = {
        title: "Vite dev server",
        purpose: "Running in app, outside any terminal this app can show.",
        origin: "unknown",
        kind: "workspace",
    } as const;
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

test("ports.forward maps a listener onto a slot and refuses reserved/dead ports", async () => {
    const client = routesClient(
        portsContract,
        createPortsRoutes(
            portsDeps({
                scanPorts: async () => [{ port: 3000, host: "127.0.0.1", forwardable: true, pid: 7, command: "vite" }],
            }),
        ),
    );

    // The slot's hostname needs no setup; the edge routes it by parsing the id out of the name.
    expect(await client.forward({ port: 3000 })).toEqual({ previewUrl: portUrl(SLOT, "example.com", sandboxIdFromToken("tok")) });
    // The daemon's own surfaces are never forwardable; an unlistened port is NOT_FOUND.
    expect(await errorCode(client.forward({ port: 8787 }))).toBe("BAD_REQUEST");
    expect(await errorCode(client.forward({ port: 4000 }))).toBe("NOT_FOUND");
    // Unforward frees the slot; the port reads unforwarded again.
    expect(await client.unforward({ port: 3000 })).toEqual({ ok: true });
    // No cwd and no session to attribute it to; the row says so and files under system.
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

// Preview offers a server an agent left running for the person by its job's own name, and stops it through the job.
test("ports.list names the conversation's job on a port an agent's turn left running for the person", async () => {
    const conversations = memoryFleet().conversations;
    const job = openBackgroundJob(
        { conversationId: "conv-served", profile: {}, conversations },
        { command: "pnpm dev --port 4173", session: "agent-conv-served", description: "Start the app's dev server" },
    );
    if (job === undefined) {
        throw new Error("the job dir could not be minted");
    }
    try {
        handJobOver(conversations, job, [4173]);
        const client = routesClient(
            portsContract,
            createPortsRoutes(
                portsDeps({
                    jobOn: (port) => portJobOf(conversations, port),
                    scanPorts: async () => [
                        { port: 4173, host: "127.0.0.1", forwardable: true },
                        { port: 3000, host: "127.0.0.1", forwardable: true },
                    ],
                }),
            ),
        );
        const listed = (await client.list()).ports;
        expect(listed.find((port) => port.port === 4173)?.job).toEqual({ conversationId: "conv-served", jobId: job.id, label: "Start the app's dev server" });
        expect(listed.find((port) => port.port === 3000)?.job).toBeUndefined();
    } finally {
        rmSync(job.dir, { recursive: true, force: true });
    }
});
