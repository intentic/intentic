import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { portsContract } from "@intentic/sandbox-contract/contracts/ports.contract";
import { portUrl } from "@intentic/sandbox-contract/ids/hostnames";
import { portSlotsFromToken, sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { workspacePaths } from "../workspace/workspace.js";
import { memoryFleet } from "../conversations/registry/agents-registry.testing.js";
import { testConfig } from "../env.config.testing.js";
import { errorCode, proven, routesClient } from "../harness/route-client.testing.js";
import { authSliceFake } from "../auth/auth-slice.testing.js";
import { fakeServiceProcesses } from "../processes/processes-slice.testing.js";
import { handJobOver, openBackgroundJob, portJobOf } from "../agent/tools/jobs/background-jobs.js";
import { createPortForwards } from "./port-forwards.js";
import { createPortsRoutes, type PortsRoutesDeps } from "./ports.routes.js";
import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import type { ProvenCaller } from "../auth/auth.js";
import { PREVIEW_PASS_PATH } from "../auth/previews/preview-guard.js";
import { memoryPreviewGuards, memoryPreviewGuardStore } from "../auth/previews/preview-guard.testing.js";

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
    // No tunnel to one of the owner's computers is open, so no port is that computer's own.
    deviceTunnels: { ports: () => new Set<number>() } as unknown as PortsRoutesDeps["deviceTunnels"],
    // Nothing installed here, so every listener is named from its own command and session alone.
    files: { read: async () => undefined },
    capabilities: { list: async () => [] },
    serviceProcesses: fakeServiceProcesses(),
    // No conversation has left a job running here, so no port is claimed by one.
    jobOn: () => undefined,
    // Loopback, as a suite's daemon is unless it says otherwise; the preview guard off until a test turns it on.
    auth: undefined,
    previewGuards: memoryPreviewGuards({ sandboxId: sandboxIdFromToken("tok"), zone: "example.com" }),
    ...overrides,
});

// The routes as the bearer middleware hands them a caller: `identity` is who signed in, absent for a call nobody did.
const clientAs = (deps: PortsRoutesDeps, identity?: ProvenCaller): ContractRouterClient<typeof portsContract> => {
    const handler = new OpenAPIHandler(createPortsRoutes(deps));
    return createORPCClient(
        new OpenAPILink(portsContract, {
            url: "http://sandbox",
            fetch: async (request) => {
                const url = new URL(request.url);
                const asked = { headers: request.headers, method: request.method, url: url.pathname + url.search };
                const { response } = await handler.handle(request, { context: identity === undefined ? asked : { ...asked, identity } });
                return response ?? new Response("no matching procedure", { status: 404 });
            },
        }),
    );
};

const ID = sandboxIdFromToken("tok")!;
const PANEL_URL = `https://preview-web-${ID}.example.com/app?x=1#top`;
const PORT_URL = portUrl(SLOT, "example.com", ID)!;

describe("the preview guard's routes", () => {
    test("previews are open to anyone with the address until the owner says otherwise", async () => {
        const client = clientAs(portsDeps(), proven("ada@example.com", "viewer"));
        expect(await client.previewGuard()).toEqual({ scope: "off" });
        expect(await client.previewPass({ url: PANEL_URL })).toEqual({ url: PANEL_URL });
    });

    test("only the signed-in owner changes it", async () => {
        const store = memoryPreviewGuardStore();
        const previewGuards = memoryPreviewGuards({ store, sandboxId: ID, zone: "example.com" });
        expect(await errorCode(clientAs(portsDeps({ previewGuards })).setPreviewGuard({ scope: "all" }))).toBe("FORBIDDEN");
        // The fake's authorizer refuses everyone it was not told to admit.
        const refused = portsDeps({ previewGuards, auth: authSliceFake({ auth: {} }, undefined).auth });
        expect(await errorCode(clientAs(refused).setPreviewGuard({ scope: "all" }))).toBe("FORBIDDEN");
        expect(await store.scope()).toBe("off");
        const owner = portsDeps({ previewGuards, auth: authSliceFake({ auth: { authorizeOwner: async () => undefined } }, undefined).auth });
        expect(await clientAs(owner).setPreviewGuard({ scope: "panels" })).toEqual({ scope: "panels" });
        expect(await store.scope()).toBe("panels");
    });

    test("a member's pass for a covered preview is a one-time link on that preview's own host", async () => {
        const previewGuards = memoryPreviewGuards({ store: memoryPreviewGuardStore("panels"), sandboxId: ID, zone: "example.com" });
        const client = clientAs(portsDeps({ previewGuards }), proven("ada@example.com", "viewer"));
        const { url } = await client.previewPass({ url: PANEL_URL });
        const link = new URL(url);
        expect(`${link.origin}${link.pathname}`).toBe(`https://preview-web-${ID}.example.com${PREVIEW_PASS_PATH}`);
        expect(link.searchParams.get("to")).toBe("/app?x=1");
        expect(link.hash).toBe("#top");
        expect(previewGuards.redeem(link.searchParams.get("ticket") ?? "", link.hostname)).toBe("ada@example.com");
        // Forwarded ports are left out at `panels`, so their address comes back as it was.
        expect(await client.previewPass({ url: PORT_URL })).toEqual({ url: PORT_URL });
    });

    test("never a ticket for an address that is not this sandbox's, nor for nobody", async () => {
        const previewGuards = memoryPreviewGuards({ store: memoryPreviewGuardStore("all"), sandboxId: ID, zone: "example.com" });
        const client = clientAs(portsDeps({ previewGuards }), proven("ada@example.com", "viewer"));
        for (const foreign of [`https://preview-web-${ID}.evil.example/`, `http://preview-web-${ID}.example.com/`, "https://example.com/", "not a url"]) {
            expect(await errorCode(client.previewPass({ url: foreign }))).toBe("BAD_REQUEST");
        }
        expect(await errorCode(clientAs(portsDeps({ previewGuards })).previewPass({ url: PANEL_URL }))).toBe("FORBIDDEN");
    });
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
    // A tmp of its own: a restart's sweep in another file ends every job dir it finds that never ran.
    const tmp = mkdtempSync(join(tmpdir(), "ports-routes-test-"));
    const job = openBackgroundJob(
        { conversationId: "conv-served", profile: {}, conversations, tmp },
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
        rmSync(tmp, { recursive: true, force: true });
    }
});

// A DevTools port is the whole browser: anyone who reaches it reads every cookie and drives every tab of whichever
// account that Chromium is signed into, with no credential asked. Forwarding is what makes a port public, so the Ports
// panel listing one must never be a click away from handing a signed-in session to the internet.
test("ports.forward refuses a Chromium DevTools port, wherever its process runs and whatever it is called", async () => {
    const chromium = "/opt/chromium/chrome --no-sandbox --user-data-dir=/work/.intentic/local/browser/identity --remote-debugging-port=41234";
    const portForwards = createPortForwards(portSlotsFromToken("tok"), async () => "http");
    const client = routesClient(
        portsContract,
        createPortsRoutes(
            portsDeps({
                portForwards,
                scanPorts: async () => [
                    { port: 41_234, host: "127.0.0.1", forwardable: true, pid: 9, command: chromium },
                    // The same flag on a Chromium a repo's own test runner started still opens the same door.
                    { port: 41_235, host: "127.0.0.1", forwardable: true, pid: 10, command: "/usr/lib/chromium/chromium --remote-debugging-port=41235", cwd: `${WORKSPACE_ROOT}/app` },
                ],
            }),
        ),
    );
    expect(await errorCode(client.forward({ port: 41_234 }))).toBe("BAD_REQUEST");
    expect(await errorCode(client.forward({ port: 41_235 }))).toBe("BAD_REQUEST");
    expect(portForwards.slotOf(41_234)).toBeUndefined();
    expect(portForwards.slotOf(41_235)).toBeUndefined();
});

// A tunnel to one of the owner's computers listens here on that computer's own port; mirrored back to it, every
// connection would loop through the computer into itself.
test("a port a device tunnel holds is never offered for mirroring", async () => {
    const client = routesClient(
        portsContract,
        createPortsRoutes(
            portsDeps({
                scanPorts: async () => [
                    { port: 3000, host: "127.0.0.1", forwardable: true },
                    { port: 5173, host: "127.0.0.1", forwardable: true },
                ],
                deviceTunnels: { ports: () => new Set([5173]) } as unknown as PortsRoutesDeps["deviceTunnels"],
            }),
        ),
    );
    expect((await client.list()).ports.map((entry) => entry.port)).toEqual([3000]);
});
