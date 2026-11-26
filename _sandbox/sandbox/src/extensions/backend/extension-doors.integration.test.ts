import { createHash, createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unstubbed } from "@intentic/testing";
import { waitFor, SETTLES } from "@intentic/testing/bun";
import { ExtensionManifestSchema, PUBLIC_ROUTE_TURNSTILE_HEADER } from "@intentic/extension-manifest";
import { EXTENSION_CALLER_HEADER, PUBLIC_DOOR_POW_CALLER_HEADER, PUBLIC_DOOR_POW_HEADER } from "@intentic/sandbox-contract/extension-protocol";
import { EXTENSION_TOKEN_HEADER } from "@intentic/sandbox-contract/protocol/headers";
import { PowChallengeSchema } from "@intentic/sandbox-contract/schemas/automations";
import { z } from "zod";
import { createApp } from "../../app.js";
import type { ProvenCaller } from "../../auth/auth.js";
import type { AutomationRecord } from "../../automations/automations-store.js";
import { memoryAutomationsStore } from "../../automations/automations-slice.testing.js";
import { approveExtension } from "../../capabilities/extension-inventory/extension-approvals.js";
import { workspaceExtensionsRoot } from "../../capabilities/extension-dirs.js";
import { installedExtensions } from "../../capabilities/extension-inventory/installed-extensions.js";
import type { Services } from "../../composition.js";
import { testConfig } from "../../env.config.testing.js";
import { memoryAreasStore } from "../../harness/route-stores.testing.js";
import { services } from "../../harness/route-services.testing.js";
import { workspacePaths } from "../../workspace/workspace.js";
import { createExtensionBackend, type ExtensionBackend } from "./backend-supervisor.js";
import { mintCallerAssertion } from "./caller-assertion.js";

// The two doors into an extension's backend that a stranger and a person each come through, end to end against a real
// spawned backend host, tried the way an attacker would: a public route's call unsigned, forged, replayed, from an origin
// off the list, without its proof of work, too large or too often; and a person's assertion carried by the wrong
// credential, to the wrong extension, past its window, or by someone the roster no longer holds. Nothing refused may
// reach the backend, and every turn POST /agent starts for a person holds no more than that person.

const started: ExtensionBackend[] = [];
afterEach(() => {
    for (const backend of started.splice(0)) {
        backend.stop();
    }
});

// The backend under test: it says who `api.caller` names, hands back its assertion, and records every public call it
// hears with what the door said it checked.
const SERVER = `const heard = [];
export const activateServer = (api) => {
    api.routes.mount(async (request) => {
        const url = new URL(request.url);
        const caller = api.caller(request);
        if (url.pathname === "/who") {
            return Response.json({
                caller: caller === undefined ? null : { kind: caller.kind, email: caller.email ?? null, tier: caller.tier ?? null, folders: caller.folders ?? null, shop: caller.reaches("shop"), bank: caller.reaches("bank") },
                credentials: ["authorization", "cookie", "x-intentic-panel", "x-intentic-extension", "x-intentic-control"].filter((name) => request.headers.has(name)),
            });
        }
        if (url.pathname === "/assertion") {
            return Response.json({ assertion: caller?.assertion ?? null });
        }
        if (url.pathname === "/heard") {
            return Response.json(heard);
        }
        return undefined;
    });
    api.publicRoutes.serve(async (request, verified) => {
        const url = new URL(request.url);
        heard.push({ path: url.pathname, query: url.search, verified, body: request.method === "GET" ? null : await request.text(), authorization: request.headers.get("authorization") });
        return Response.json({ ok: true });
    });
};
`;

const LISTENER = {
    provider: "crashes",
    strangers: "report",
    events: [{ type: "report", label: "Reports" }],
    automation: { label: "Crashes", channel: { label: "Site", placeholder: "every site" }, starterPrompt: "A crash arrived." },
};

const MANIFEST = {
    publisher: "acme",
    name: "doors",
    version: "1.0.0",
    engines: { intentic: "^2.53.0" },
    server: "server.js",
    permissions: { daemon: ["POST /agent"] },
    contributes: {
        listener: LISTENER,
        publicRoutes: [
            { path: "stripe", methods: ["POST"], signature: { scheme: "stripe", secret: "STRIPE_SECRET" } },
            { path: "*/report", methods: ["POST"], automation: true, origins: "listed", key: true, dailyMax: 3 },
            { path: "*/keyed", methods: ["POST"], automation: true, origins: "listed", key: true, keyFromBrowsers: true },
            { path: "counted.js", methods: ["GET"], rate: 600, dailyMax: 2 },
            { path: "static.js", methods: ["GET"], rate: 600, dailyMax: "none" },
            { path: "*/solved", methods: ["POST"], automation: true, proofOfWork: true },
            { path: "open", methods: ["GET", "POST"], bodyMax: 16, rate: 2 },
            { path: "human", methods: ["POST"], turnstile: { secret: "TURNSTILE_SECRET" } },
            { path: "unset", methods: ["POST"], turnstile: { secret: "NO_SUCH_SECRET" } },
        ],
    },
};

const STRIPE_SECRET = "whsec_a-secret-only-the-sandbox-holds";
const TURNSTILE_SECRET = "0x4AAA-turnstile-secret-only-the-sandbox-holds";
const SITE = "https://shop.example";

const crashes = (id: string, enabled = true, keyFromBrowsers = false): AutomationRecord => ({
    id,
    trigger: { kind: "listener", provider: "crashes", allowedOrigins: [SITE], keyFromBrowsers },
    prompt: "Fix it.",
    models: [{ provider: "claude", model: "claude-sonnet-4-6" }],
    enabled,
    runs: [],
});

// The people the authorizer knows: a collaborator fenced to the shop's area, a viewer, and nobody else.
const INTERN: ProvenCaller = { email: "intern@example.com", tier: "collaborator", areas: ["shop-area"], methods: ["google"] };
const VIEWER: ProvenCaller = { email: "viewer@example.com", tier: "viewer", methods: ["google"] };
const people = new Map([
    ["Bearer intern", INTERN],
    ["intern@example.com", INTERN],
    ["Bearer viewer", VIEWER],
    ["viewer@example.com", VIEWER],
]);
const personOf = (key: string): ProvenCaller => {
    const person = people.get(key);
    if (person === undefined) {
        throw new Error("not on the roster");
    }
    return person;
};

const harness = async (): Promise<{ readonly svc: Services; readonly app: ReturnType<typeof createApp>; readonly token: string }> => {
    const root = mkdtempSync(join(tmpdir(), "ext-doors-"));
    const history = `${root}-history`;
    const dir = join(workspaceExtensionsRoot(root), "doors");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "intentic-extension.json"), JSON.stringify(MANIFEST));
    await writeFile(join(dir, "server.js"), SERVER);
    await approveExtension(history, "acme.doors", ExtensionManifestSchema.parse(MANIFEST));
    // The supervisor and the services each need the other: the supervisor reads the services only once the host starts.
    // The test host's forwarded lines are noise unless it fails.
    const quiet = unstubbed<Services["logger"]>("logger", { info: () => undefined, warn: () => undefined, error: console.error });
    const backend = createExtensionBackend(() => svc, 0, quiet);
    started.push(backend);
    const svc = services({
        workspace: workspacePaths(root),
        config: { ...testConfig, extensionsDir: "", historyRoot: history },
        extensionBackend: backend,
        automations: memoryAutomationsStore([crashes("bugs-1"), crashes("bugs-off", false), crashes("bugs-open", true, true)]),
        areas: memoryAreasStore([{ id: "shop-area", folders: ["shop"] }]),
        auth: {
            authorize: async (bearer: string) => personOf(`Bearer ${bearer}`),
            authorizeProven: async (proof) => personOf(proof.email),
        },
    });
    await svc.sandboxSecrets.set("STRIPE_SECRET", STRIPE_SECRET);
    await svc.sandboxSecrets.set("TURNSTILE_SECRET", TURNSTILE_SECRET);
    await backend.start();
    const installed = (await installedExtensions(svc)).find((extension) => extension.id === "acme.doors");
    if (installed === undefined) {
        throw new Error("the extension under test did not install");
    }
    return { svc, app: createApp(svc), token: backend.grantFor(installed) };
};

const HeardSchema = z.array(z.object({ path: z.string(), query: z.string(), verified: z.record(z.string(), z.unknown()), body: z.string().nullable(), authorization: z.string().nullable() }));
const heard = async (app: ReturnType<typeof createApp>) => HeardSchema.parse(await (await app.request("http://sandbox.test/x/acme.doors/heard", { headers: { authorization: "Bearer intern" } })).json());

const stripeSigned = (body: string, secret: string, at = Math.floor(Date.now() / 1000)) => ({
    "content-type": "application/json",
    "stripe-signature": `t=${at},v1=${createHmac("sha256", secret).update(`${at}.${body}`).digest("hex")}`,
});

describe("a public route", () => {
    test("a call signed by the provider reaches the backend once, with what was checked; unsigned, forged, stale or replayed ones never do", async () => {
        const { app } = await harness();
        const body = JSON.stringify({ id: "evt_1", type: "invoice.paid" });
        const post = (headers: Record<string, string>, sent = body) => app.request("http://sandbox.test/door/acme.doors/stripe", { method: "POST", headers, body: sent });

        expect((await post({ "content-type": "application/json" })).status).toBe(401);
        expect((await post(stripeSigned(body, "whsec_someone-elses-secret"))).status).toBe(401);
        // Signed, then the body changed on the way.
        expect((await post(stripeSigned(body, STRIPE_SECRET), body.replace("invoice.paid", "invoice.void"))).status).toBe(401);
        // A capture replayed ten minutes on.
        expect((await post(stripeSigned(body, STRIPE_SECRET, Math.floor(Date.now() / 1000) - 600))).status).toBe(401);
        expect(await heard(app)).toEqual([]);

        const taken = await post(stripeSigned(body, STRIPE_SECRET));
        expect(taken.status).toBe(200);
        // The provider retrying the same delivery, freshly signed: answered, and the backend does not hear it twice.
        const again = await post(stripeSigned(body, STRIPE_SECRET));
        expect(await again.json()).toEqual({ ok: true, receipt: "duplicate" });
        const calls = await heard(app);
        expect(calls).toHaveLength(1);
        expect(calls[0]?.verified).toEqual({ route: "stripe", at: expect.any(Number), signature: { scheme: "stripe", deliveryId: "evt_1" } });
        expect(calls[0]?.body).toBe(body);
    });

    test("an automation's route admits a listed origin, or the automation's key from a caller with none, and nothing else", async () => {
        const { svc, app } = await harness();
        const key = await svc.doorTokens.ensure("intake", "bugs-1");
        const post = (path: string, headers: Record<string, string>) => app.request(`http://sandbox.test/door/acme.doors/${path}`, { method: "POST", headers, body: "{}" });

        expect((await post("bugs-1/report", { origin: "https://evil.example" })).status).toBe(403);
        // A key never stands in for a browser on a site off the list.
        expect((await post("bugs-1/report", { origin: "https://evil.example", authorization: `Bearer ${key}` })).status).toBe(403);
        expect((await post("bugs-1/report", { authorization: "Bearer ik_guessed" })).status).toBe(403);
        expect((await post("bugs-1/report", {})).status).toBe(403);
        expect((await post("nobody/report", { origin: SITE })).status).toBe(404);
        expect((await post("bugs-off/report", { origin: SITE })).status).toBe(409);
        expect(await heard(app)).toEqual([]);

        expect((await post("bugs-1/report", { origin: SITE })).status).toBe(200);
        expect((await post(`bugs-1/report?key=${key}`, {})).status).toBe(200);
        const calls = await heard(app);
        expect(calls.map((call) => call.verified)).toEqual([
            { route: "*/report", at: expect.any(Number), automationId: "bugs-1", origin: SITE },
            { route: "*/report", at: expect.any(Number), automationId: "bugs-1", keyed: true },
        ]);
        // The key itself never reaches the backend.
        expect(calls[1]?.query).toBe("");
        // The day's ceiling, per automation: three taken, the fourth refused before the backend.
        expect((await post("bugs-1/report", { origin: SITE })).status).toBe(200);
        expect((await post("bugs-1/report", { origin: SITE })).status).toBe(429);
        expect(await heard(app)).toHaveLength(3);
    });

    test("a key stands in for an unlisted browser only where the route declares keyFromBrowsers and the automation opts in", async () => {
        const { app, svc } = await harness();
        const keys = { closed: await svc.doorTokens.ensure("intake", "bugs-1"), open: await svc.doorTokens.ensure("intake", "bugs-open") };
        const post = (path: string, origin: string) => app.request(`http://sandbox.test/door/acme.doors/${path}`, { method: "POST", headers: { origin }, body: "{}" });
        const elsewhere = "https://mirror.example";
        // The automation never opted in, the route never declared it, or no key came: the unlisted browser is refused.
        expect((await post(`bugs-1/keyed?key=${keys.closed}`, elsewhere)).status).toBe(403);
        expect((await post(`bugs-open/report?key=${keys.open}`, elsewhere)).status).toBe(403);
        expect((await post("bugs-open/keyed", elsewhere)).status).toBe(403);
        expect((await post(`bugs-open/keyed?key=${keys.closed}`, elsewhere)).status).toBe(403);
        expect(await heard(app)).toEqual([]);
        // Both said so, and the automation's own key came: the browser is in, its Origin and the key both said.
        expect((await post(`bugs-open/keyed?key=${keys.open}`, elsewhere)).status).toBe(200);
        // A listed site needs no key on that route either.
        expect((await post("bugs-open/keyed", SITE)).status).toBe(200);
        expect((await heard(app)).map((call) => call.verified)).toEqual([
            { route: "*/keyed", at: expect.any(Number), automationId: "bugs-open", origin: elsewhere, keyed: true },
            { route: "*/keyed", at: expect.any(Number), automationId: "bugs-open", origin: SITE },
        ]);
    });

    test('a GET-only route declaring dailyMax "none" counts no day, where one declaring a ceiling stops at it', async () => {
        const { app } = await harness();
        const get = async (path: string): Promise<number[]> => {
            const statuses: number[] = [];
            for (let call = 0; call < 4; call++) {
                statuses.push((await app.request(`http://sandbox.test/door/acme.doors/${path}`)).status);
            }
            return statuses;
        };
        expect(await get("counted.js")).toEqual([200, 200, 429, 429]);
        expect(await get("static.js")).toEqual([200, 200, 200, 200]);
    });

    test("a route asking for proof of work refuses a call without a solved challenge signed to its caller", async () => {
        const { app } = await harness();
        const post = (headers: Record<string, string>) => app.request("http://sandbox.test/door/acme.doors/bugs-1/solved", { method: "POST", headers, body: "{}" });
        expect((await post({})).status).toBe(403);
        const challenge = PowChallengeSchema.parse(await (await app.request("http://sandbox.test/door/acme.doors/~challenge?caller=tab-1")).json());
        let nonce = 0;
        while (!createHash("sha256").update(`${challenge.salt}:${nonce}`).digest().subarray(0, 2).every((byte) => byte === 0)) {
            nonce += 1;
        }
        const solved = `${challenge.salt}:${nonce}`;
        // Solved for one caller, presented by another.
        expect((await post({ [PUBLIC_DOOR_POW_HEADER]: solved, [PUBLIC_DOOR_POW_CALLER_HEADER]: "tab-2" })).status).toBe(403);
        expect(await heard(app)).toEqual([]);
        expect((await post({ [PUBLIC_DOOR_POW_HEADER]: solved, [PUBLIC_DOOR_POW_CALLER_HEADER]: "tab-1" })).status).toBe(200);
        expect((await heard(app))[0]?.verified).toMatchObject({ route: "*/solved", automationId: "bugs-1", proofOfWork: { caller: "tab-1" } });
    });

    test("a route asking for Turnstile refuses a call without a token Cloudflare accepts under the sandbox's secret, which never reaches the backend", async () => {
        const { app } = await harness();
        // Cloudflare's siteverify, stood in for: it passes only the one token it issued. Every other request (the door's
        // hop to the backend) goes through.
        const passThrough = globalThis.fetch;
        const asked: URLSearchParams[] = [];
        const siteverify = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
            if (String(input) !== "https://challenges.cloudflare.com/turnstile/v0/siteverify") {
                return passThrough(input, init);
            }
            const form = new URLSearchParams(String(init?.body));
            asked.push(form);
            return Response.json({ success: form.get("secret") === TURNSTILE_SECRET && form.get("response") === "issued-token" });
        };
        const cloudflare = jest.spyOn(globalThis, "fetch").mockImplementation(Object.assign(siteverify, { preconnect: passThrough.preconnect }));
        try {
            const post = (path: string, headers: Record<string, string>) => app.request(`http://sandbox.test/door/acme.doors/${path}`, { method: "POST", headers, body: "{}" });
            expect((await post("human", {})).status).toBe(403);
            expect((await post("human", { [PUBLIC_ROUTE_TURNSTILE_HEADER]: "forged-token" })).status).toBe(403);
            // A route whose secret the owner never set refuses everyone rather than standing open, without asking Cloudflare.
            expect((await post("unset", { [PUBLIC_ROUTE_TURNSTILE_HEADER]: "issued-token" })).status).toBe(403);
            expect(asked.map((form) => form.get("response"))).toEqual(["forged-token"]);
            expect(await heard(app)).toEqual([]);

            const taken = await post("human", { [PUBLIC_ROUTE_TURNSTILE_HEADER]: "issued-token" });
            expect(taken.status).toBe(200);
            const calls = await heard(app);
            expect(calls).toHaveLength(1);
            expect(calls[0]?.verified).toEqual({ route: "human", at: expect.any(Number), turnstile: true });
            expect(JSON.stringify(calls)).not.toContain(TURNSTILE_SECRET);
        } finally {
            cloudflare.mockRestore();
        }
    });

    test("its body ceiling, its minute's window, an undeclared path or method, and the /x namespace are each closed to a stranger", async () => {
        const { app } = await harness();
        const open = (init: RequestInit = {}) => app.request("http://sandbox.test/door/acme.doors/open", init);
        expect((await open({ method: "POST", body: "x".repeat(17) })).status).toBe(413);
        expect((await open({ method: "DELETE" })).status).toBe(404);
        expect((await app.request("http://sandbox.test/door/acme.doors/undeclared")).status).toBe(404);
        expect((await app.request("http://sandbox.test/door/acme.nobody/open")).status).toBe(404);
        // Credentials a stranger sends never ride on into the backend.
        expect((await open({ headers: { authorization: "Bearer stolen", "cf-connecting-ip": "203.0.113.9" } })).status).toBe(200);
        expect((await open({ headers: { "cf-connecting-ip": "203.0.113.9" } })).status).toBe(200);
        expect((await open({ headers: { "cf-connecting-ip": "203.0.113.9" } })).status).toBe(429);
        // Another caller's minute is its own.
        expect((await open({ headers: { "cf-connecting-ip": "198.51.100.7" } })).status).toBe(200);
        const calls = await heard(app);
        expect(calls.map((call) => call.authorization)).toEqual([null, null, null]);
        // The backend's /x namespace stays behind sign-in.
        expect((await app.request("http://sandbox.test/x/acme.doors/heard")).status).toBe(401);
    });
});

describe("the caller on /x", () => {
    test("a person's areas reach the backend as folders, and no caller's credential does; a forged assertion is replaced", async () => {
        const { app } = await harness();
        const forged = mintCallerAssertion({ config: { ...testConfig, connectToken: "elsewhere" } }, "acme.doors", { kind: "person", email: "owner@example.com", tier: "owner" }, undefined);
        const who = await app.request("http://sandbox.test/x/acme.doors/who", { headers: { authorization: "Bearer intern", [EXTENSION_CALLER_HEADER]: forged } });
        expect(await who.json()).toEqual({
            caller: { kind: "person", email: "intern@example.com", tier: "collaborator", folders: ["shop"], shop: true, bank: false },
            credentials: [],
        });
        const panel = await app.request("http://sandbox.test/x/acme.doors/who", { headers: { "x-intentic-panel": "panel-secret" } });
        expect(await panel.json()).toEqual({ caller: { kind: "panel", email: null, tier: null, folders: null, shop: true, bank: true }, credentials: [] });
    });

    test("POST /agent starts the turn as the person who pressed, inside their areas, and refuses every other way of carrying it", async () => {
        const { svc, app, token } = await harness();
        const assertionFor = async (bearer: string): Promise<string> =>
            z.object({ assertion: z.string() }).parse(await (await app.request("http://sandbox.test/x/acme.doors/assertion", { headers: { authorization: bearer } })).json()).assertion;
        const intern = await assertionFor("Bearer intern");
        const run = (headers: Record<string, string>, conversationId: string) =>
            app.request("http://sandbox.test/agent", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ prompt: "fix the failing build", conversationId }) });

        // A panel holding a person's assertion cannot start a turn as them; nor can another extension, or a stranger.
        expect((await run({ "x-intentic-panel": "panel-secret", [EXTENSION_CALLER_HEADER]: intern }, "by-panel")).status).toBe(403);
        expect((await run({ [EXTENSION_CALLER_HEADER]: intern }, "by-nobody")).status).toBe(401);
        expect((await run({ [EXTENSION_TOKEN_HEADER]: token, [EXTENSION_CALLER_HEADER]: `${intern}x` }, "tampered")).status).toBe(401);
        const elsewhere = mintCallerAssertion({ config: { ...testConfig, connectToken: "another-sandbox" } }, "acme.doors", { kind: "person", email: "intern@example.com", tier: "owner" }, ["google"]);
        expect((await run({ [EXTENSION_TOKEN_HEADER]: token, [EXTENSION_CALLER_HEADER]: elsewhere }, "elsewhere")).status).toBe(401);
        const stale = mintCallerAssertion(svc, "acme.doors", { kind: "person", email: "intern@example.com", tier: "collaborator" }, ["google"], Date.now() - 3 * 60_000);
        expect((await run({ [EXTENSION_TOKEN_HEADER]: token, [EXTENSION_CALLER_HEADER]: stale }, "stale")).status).toBe(401);
        // A viewer pressed: the route's floor holds them back.
        expect((await run({ [EXTENSION_TOKEN_HEADER]: token, [EXTENSION_CALLER_HEADER]: await assertionFor("Bearer viewer") }, "by-viewer")).status).toBe(403);
        for (const id of ["by-panel", "by-nobody", "tampered", "elsewhere", "stale", "by-viewer"]) {
            expect(svc.agents.entry(id)).toBeUndefined();
        }

        expect((await run({ [EXTENSION_TOKEN_HEADER]: token, [EXTENSION_CALLER_HEADER]: intern }, "as-intern")).status).toBe(200);
        await waitFor(
            () =>
                expect(svc.agents.entry("as-intern")).toMatchObject({
                    identity: { areas: ["shop-area"], people: ["intern@example.com"], startedBy: "intern@example.com" },
                    social: { owner: { email: "intern@example.com" } },
                }),
            SETTLES,
        );
    });
});
