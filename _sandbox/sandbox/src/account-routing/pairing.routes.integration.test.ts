import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemberTier } from "@intentic/sandbox-contract/schemas/shared";
import { Hono } from "hono";
import type { AppEnv } from "../app-env.js";
import type { ProvenCaller } from "../auth/auth.js";
import { createPairingRoutes } from "./pairing.routes.js";
import { filePairingsStore } from "./pairings-store.js";
import { fileRouteSecrets } from "./route-secrets.js";

// The pairing doors: each person mints, lists and revokes their own (a maintainer anyone's), a secret is said once and
// only its hash kept, and the asking side keeps the secret for the person who signed in, listing it without the secret.

const setup = () => {
    const root = mkdtempSync(join(tmpdir(), "pairing-routes-"));
    const pairings = filePairingsStore(root);
    const secretsPath = join(root, "route-secrets.json");
    const secrets = fileRouteSecrets(secretsPath);
    const routes = createPairingRoutes({ pairings, secrets, now: () => 1_800_000_000_000 });
    const as = (email: string | undefined, tier: MemberTier = "collaborator") => {
        const app = new Hono<AppEnv>();
        app.use(async (c, next) => {
            if (email !== undefined) {
                // SAFETY: the routes read only the caller's email and tier; the proof fields are the middleware's.
                c.set("identity", { email, tier } as ProvenCaller);
            }
            await next();
        });
        app.post("/account/pairings", routes.mint).get("/account/pairings", routes.list).delete("/account/pairings/:from", routes.revoke);
        app.post("/account/routes/secret", routes.keep).get("/account/routes", routes.held);
        return async (method: string, path: string, body?: unknown) => {
            const res = await app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? null : JSON.stringify(body) });
            return { status: res.status, body: await res.json() };
        };
    };
    return { root, secretsPath, pairings, as };
};

const OPS = "aaaaaaaaaaaa";

test("a person mints a pairing for themselves, is told the secret once, and only its hash is kept", async () => {
    const { root, pairings, as } = setup();
    const minted = await as("Ada@Acme.test")("POST", "/account/pairings", { from: OPS, fromName: "ops" });
    expect(minted).toMatchObject({ status: 200, body: { from: OPS, person: "ada@acme.test" } });
    const secret: string = minted.body.secret;
    expect(secret.length).toBeGreaterThanOrEqual(43);
    const stored = readFileSync(join(root, "account-pairings.json"), "utf8");
    expect(stored).not.toContain(secret);
    expect(statSync(join(root, "account-pairings.json")).mode & 0o777).toBe(0o600);
    expect(await pairings.verify(OPS, "ada@acme.test", secret)).toBe(true);
    expect((await as("ada@acme.test")("GET", "/account/pairings")).body).toEqual({
        pairings: [{ from: OPS, fromName: "ops", person: "ada@acme.test", createdAt: 1_800_000_000_000 }],
    });
});

test("a guest, and a request nobody signed in made, mint nothing", async () => {
    const { as } = setup();
    expect((await as("gus@acme.test", "guest")("POST", "/account/pairings", { from: OPS, fromName: "ops" })).status).toBe(403);
    expect((await as(undefined)("POST", "/account/pairings", { from: OPS, fromName: "ops" })).status).toBe(403);
    expect((await as("ada@acme.test")("POST", "/account/pairings", { from: "not-a-tunnel", fromName: "ops" })).status).toBe(400);
});

test("each person sees and revokes their own; a maintainer sees and revokes anyone's", async () => {
    const { as } = setup();
    await as("ada@acme.test")("POST", "/account/pairings", { from: OPS, fromName: "ops" });
    await as("bo@acme.test")("POST", "/account/pairings", { from: OPS, fromName: "ops" });
    expect((await as("bo@acme.test")("GET", "/account/pairings")).body.pairings).toHaveLength(1);
    expect((await as("mia@acme.test", "maintainer")("GET", "/account/pairings")).body.pairings).toHaveLength(2);
    expect((await as("bo@acme.test")("DELETE", `/account/pairings/${OPS}?person=ada@acme.test`)).status).toBe(403);
    expect((await as("bo@acme.test")("DELETE", `/account/pairings/${OPS}`)).status).toBe(200);
    expect((await as("bo@acme.test")("DELETE", `/account/pairings/${OPS}`)).status).toBe(404);
    expect((await as("mia@acme.test", "maintainer")("DELETE", `/account/pairings/${OPS}?person=ada@acme.test`)).status).toBe(200);
    expect((await as("mia@acme.test", "maintainer")("GET", "/account/pairings")).body.pairings).toHaveLength(0);
});

test("the asking side keeps a secret for the person who signed in, and lists what it holds without it", async () => {
    const { secretsPath, as } = setup();
    const secret = "s".repeat(43);
    expect((await as("Ada@Acme.test")("POST", "/account/routes/secret", { target: OPS, secret })).status).toBe(200);
    const listed = await as("bo@acme.test", "viewer")("GET", "/account/routes");
    expect(listed.body).toEqual({ routes: [{ target: OPS, person: "ada@acme.test", createdAt: 1_800_000_000_000 }] });
    expect(JSON.stringify(listed.body)).not.toContain(secret);
    expect(statSync(secretsPath).mode & 0o777).toBe(0o600);
    expect(await fileRouteSecrets(secretsPath).secretFor(OPS, "ADA@acme.test")).toBe(secret);
    expect((await as(undefined)("POST", "/account/routes/secret", { target: OPS, secret })).status).toBe(403);
});
