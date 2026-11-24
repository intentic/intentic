import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintSandboxPass, type PassScope, ROUTE_SECRET_HEADER, SANDBOX_PASS_HEADER } from "@intentic/sandbox-contract/sandbox-pass";
import { Hono } from "hono";
import type { AppEnv } from "../app-env.js";
import type { Caller } from "../auth/auth.js";
import { createRouteAdmission, ROUTE_PER_MINUTE } from "./admit-route.js";
import { filePairingsStore } from "./pairings-store.js";

// Admission at a door routed as a person: the pass for this sandbox and this door, the person on this roster and above
// the scope's floor, and the pairing secret they minted here for the sender. The platform's word alone opens no more.

const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const SELF = "dddddddddddd";
const OPS = "aaaaaaaaaaaa";

const ROSTER = {
    "ada@acme.test": { email: "ada@acme.test", tier: "collaborator", agents: "run" },
    "gus@acme.test": { email: "gus@acme.test", tier: "guest", agents: "chat" },
    "vic@acme.test": { email: "vic@acme.test", tier: "viewer" },
} as const satisfies Readonly<Record<string, Caller>>;
const onRoster = (email: string): Caller | undefined => Object.entries(ROSTER).find(([held]) => held === email.toLowerCase())?.[1];

const pass = (scope: PassScope, over: Partial<Parameters<typeof mintSandboxPass>[1]> = {}): string =>
    mintSandboxPass(privateKey, { from: OPS, fromName: "ops", to: SELF, scope, person: "ada@acme.test", issuedAtMs: Date.now(), ...over });

const setup = async () => {
    const pairings = filePairingsStore(mkdtempSync(join(tmpdir(), "pairings-")));
    const { secret } = await pairings.mint({ from: OPS, fromName: "ops", person: "Ada@Acme.test" }, Date.now());
    const admit = createRouteAdmission({
        identityKey: async () => publicKey,
        self: SELF,
        roster: async () => ({ callerOf: onRoster }),
        pairings: () => pairings,
    });
    const app = new Hono<AppEnv>();
    for (const scope of ["report", "drop", "read", "task"] as const) {
        app.post(`/${scope}`, async (c) => {
            const admitted = await admit(c, scope);
            return admitted instanceof Response ? admitted : c.json({ person: admitted.person?.email ?? null, from: admitted.pass.from });
        });
    }
    const post = async (scope: PassScope, headers: Readonly<Record<string, string>>) => {
        const res = await app.request(`/${scope}`, { method: "POST", headers });
        const body: { error?: string; code?: string; person?: string | null } = await res.json();
        return { status: res.status, ...body };
    };
    return { pairings, secret, post };
};

test("a drop pass for this sandbox, its person on the roster and paired with the sender, is admitted as that person", async () => {
    const { secret, post } = await setup();
    expect(await post("drop", { [SANDBOX_PASS_HEADER]: pass("drop"), [ROUTE_SECRET_HEADER]: secret })).toMatchObject({ status: 200, person: "ada@acme.test" });
});

test("a pass for another door's scope is refused as a pass", async () => {
    const { secret, post } = await setup();
    expect(await post("task", { [SANDBOX_PASS_HEADER]: pass("drop"), [ROUTE_SECRET_HEADER]: secret })).toMatchObject({ status: 401, code: "pass" });
});

test("a person not on this roster, or below the scope's floor, is refused in words saying so", async () => {
    const { secret, post } = await setup();
    const stranger = await post("drop", { [SANDBOX_PASS_HEADER]: pass("drop", { person: "eve@elsewhere.test" }), [ROUTE_SECRET_HEADER]: secret });
    expect(stranger).toMatchObject({ status: 403, code: "not_member" });
    expect(stranger.error).toContain("not a member");
    expect(await post("drop", { [SANDBOX_PASS_HEADER]: pass("drop", { person: "vic@acme.test" }), [ROUTE_SECRET_HEADER]: secret })).toMatchObject({ status: 403, code: "floor" });
    expect(await post("task", { [SANDBOX_PASS_HEADER]: pass("task", { person: "gus@acme.test" }), [ROUTE_SECRET_HEADER]: secret })).toMatchObject({ status: 403, code: "floor" });
});

test("a missing or wrong pairing secret is refused as the pairing, naming what the person does about it", async () => {
    const { secret, post, pairings } = await setup();
    const missing = await post("read", { [SANDBOX_PASS_HEADER]: pass("read") });
    expect(missing).toMatchObject({ status: 403, code: "pairing" });
    expect(missing.error).toContain("allow");
    expect(await post("read", { [SANDBOX_PASS_HEADER]: pass("read"), [ROUTE_SECRET_HEADER]: `${secret}x` })).toMatchObject({ status: 403, code: "pairing" });
    // The secret is the person's for this sender only: the same one from another sandbox opens nothing.
    expect(await post("read", { [SANDBOX_PASS_HEADER]: pass("read", { from: "bbbbbbbbbbbb" }), [ROUTE_SECRET_HEADER]: secret })).toMatchObject({ code: "pairing" });
    // Revoked, it opens nothing either.
    await pairings.revoke(OPS, "ada@acme.test");
    expect(await post("read", { [SANDBOX_PASS_HEADER]: pass("read"), [ROUTE_SECRET_HEADER]: secret })).toMatchObject({ status: 403, code: "pairing" });
});

test("a report needs no pairing, and its person is kept only when the roster knows them", async () => {
    const { post } = await setup();
    const report = (person?: string) => pass("report", { project: "github.com/acme/app", person });
    expect(await post("report", { [SANDBOX_PASS_HEADER]: report("ada@acme.test") })).toMatchObject({ status: 200, person: "ada@acme.test" });
    expect(await post("report", { [SANDBOX_PASS_HEADER]: report("eve@elsewhere.test") })).toMatchObject({ status: 200, person: null });
    expect(await post("report", { [SANDBOX_PASS_HEADER]: report() })).toMatchObject({ status: 200, person: null });
});

test("each sender has a minute per scope, spent before the secret is checked so guesses are limited too", async () => {
    const { secret, post } = await setup();
    for (let sent = 0; sent < ROUTE_PER_MINUTE.task; sent += 1) {
        await post("task", { [SANDBOX_PASS_HEADER]: pass("task"), [ROUTE_SECRET_HEADER]: "a-guess" });
    }
    expect(await post("task", { [SANDBOX_PASS_HEADER]: pass("task"), [ROUTE_SECRET_HEADER]: secret })).toMatchObject({ status: 429, code: "rate" });
    // Another scope's minute is its own.
    expect(await post("drop", { [SANDBOX_PASS_HEADER]: pass("drop"), [ROUTE_SECRET_HEADER]: secret })).toMatchObject({ status: 200 });
});
