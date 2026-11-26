import type { ExtensionCallerIdentity } from "@intentic/sandbox-contract/extension-protocol";
import type { ExtensionServerApi } from "./server.js";
import { type FakeExtension, fakeExtensionApi } from "./testing.js";

// Who a request into a backend comes from (`api.caller`), handed back to the daemon to act as them
// (`api.daemon.asCaller`), and the public routes a backend serves (`api.publicRoutes.serve`), on the SDK's fake daemon,
// which believes only the assertions its own proxy minted, as the daemon believes only its own key's.

const opened: FakeExtension[] = [];
const fake = async (options: Parameters<typeof fakeExtensionApi>[0]): Promise<FakeExtension> => {
    const made = await fakeExtensionApi(options);
    opened.push(made);
    return made;
};
afterEach(async () => {
    await Promise.all(opened.splice(0).map((each) => each.dispose()));
});

const manifest = {
    publisher: "acme",
    name: "fixer",
    permissions: { daemon: ["POST /agent"] },
    contributes: { publicRoutes: [{ path: "hook", methods: ["POST" as const] }, { path: "*/report", methods: ["POST" as const], automation: true as const }] },
};

// A backend whose button starts a turn as whoever pressed it, and answers what it knows of them.
const fixer = {
    activateServer: (api: ExtensionServerApi) => {
        api.routes.mount(async (request) => {
            const caller = api.caller(request);
            if (new URL(request.url).pathname === "/who") {
                return Response.json(caller === undefined ? null : { kind: caller.kind, folders: caller.folders ?? null, app: caller.reaches("app"), web: caller.reaches("app/web"), up: caller.reaches("../app") });
            }
            if (caller === undefined) {
                return Response.json({ error: "nobody vouched for this caller" }, { status: 401 });
            }
            const started = await api.daemon.asCaller(caller).request("/agent", { method: "POST", body: JSON.stringify({ prompt: "fix it", conversationId: "fix-1" }) });
            return new Response(null, { status: started.status });
        });
        api.publicRoutes.serve(async (_request, verified) => Response.json(verified));
    },
};

test("a backend reads who pressed, and the folders their areas hold, by segment", async () => {
    const extension = await fake({ manifest });
    await extension.activate(fixer);
    expect(await (await extension.route("who", undefined, { caller: { kind: "person", email: "i@example.com", tier: "collaborator", areas: ["a"], folders: ["app/web"] } })).json()).toEqual({
        kind: "person",
        folders: ["app/web"],
        app: false,
        web: true,
        up: false,
    });
    expect(await (await extension.route("who", undefined, { caller: { kind: "panel" } })).json()).toEqual({ kind: "panel", folders: null, app: true, web: true, up: false });
    // Past its window, an assertion is no caller at all.
    expect(await (await extension.route("who", undefined, { mintedAgoMs: 120_001 })).json()).toBeNull();
});

test("asCaller carries the person's assertion to the daemon, which believes it only inside its window", async () => {
    const extension = await fake({ manifest, daemon: () => Response.json({ delivered: "started", run: "r1" }) });
    await extension.activate(fixer);
    const intern: ExtensionCallerIdentity = { kind: "person", email: "intern@example.com", tier: "collaborator", areas: ["shop"], folders: ["shop"] };

    expect((await extension.route("start", { method: "POST" }, { caller: intern })).status).toBe(200);
    // A press answered after its window, handed back to the daemon too late.
    expect((await extension.route("start", { method: "POST" }, { caller: intern, mintedAgoMs: 120_001 })).status).toBe(401);
    expect(extension.calls).toEqual([{ line: "POST /agent", admitted: true, caller: { kind: "person", email: "intern@example.com", tier: "collaborator", areas: ["shop"] } }]);
});

test("an assertion this fake's proxy did not mint is refused by its daemon, as the daemon refuses one not signed with its key", async () => {
    const extension = await fake({ manifest, daemon: () => Response.json({}) });
    await extension.activate({
        activateServer: (api: ExtensionServerApi) => {
            api.routes.mount(async (request) => {
                const caller = api.caller(request);
                if (caller === undefined) {
                    return undefined;
                }
                // The claim rewritten to name the owner, with the signature it came with.
                const [encoded = "", signature = ""] = caller.assertion.split(".");
                const claim = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
                const promoted = Buffer.from(JSON.stringify({ ...claim, caller: { kind: "person", email: "owner@example.com", tier: "owner" } }), "utf8").toString("base64url");
                const forged = { ...caller, assertion: `${promoted}.${signature}` };
                return new Response(null, { status: (await api.daemon.asCaller(forged).request("/agent", { method: "POST", body: "{}" })).status });
            });
        },
    });
    expect((await extension.route("start", { method: "POST" }, { caller: { kind: "panel" } })).status).toBe(401);
    expect(extension.calls).toEqual([{ line: "POST /agent", admitted: false }]);
});

test("a public route hears what the door checked, and a path or method no route declares never reaches it", async () => {
    const extension = await fake({ manifest });
    await extension.activate(fixer);
    expect(await (await extension.publicRoute("bugs-1/report", { method: "POST", body: "{}" }, { origin: "https://shop.example" })).json()).toEqual({
        route: "*/report",
        at: expect.any(Number),
        automationId: "bugs-1",
        origin: "https://shop.example",
    });
    expect(await (await extension.publicRoute("hook", { method: "POST" }, { signature: { scheme: "github", deliveryId: "d-1" } })).json()).toEqual({
        route: "hook",
        at: expect.any(Number),
        signature: { scheme: "github", deliveryId: "d-1" },
    });
    await expect(extension.publicRoute("hook", { method: "GET" })).rejects.toThrow('"acme.fixer" declares no public route answering GET /hook');
    await expect(extension.publicRoute("other", { method: "POST" })).rejects.toThrow("declares no public route");
});
