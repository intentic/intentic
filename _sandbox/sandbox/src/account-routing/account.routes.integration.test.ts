import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountReport, AccountReportFiled } from "@intentic/sandbox-contract/schemas/issues";
import { mintSandboxPass, SANDBOX_PASS_HEADER } from "@intentic/sandbox-contract/sandbox-pass";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { unstubbed } from "@intentic/testing";
import { Hono } from "hono";
import type { Services } from "../composition.js";
import { memoryMembersStore } from "../harness/route-stores.testing.js";
import { createAccountRoutes, fileWithInbox, type Filing } from "./account.routes.js";

// The receiving door of account-level report routing. What matters: only a pass the platform signed for THIS sandbox
// gets in, who reported is read from the pass and never from the body, and what got in is handed to the issues inbox
// whole (2026-11-26: the inbox is the issues extension's), or answered "not now" so the sender's outbox keeps it.

const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const CONNECT_TOKEN = "connect-token-of-the-receiver";
const SELF = sandboxIdFromToken(CONNECT_TOKEN) ?? "";
const OPS = "aaaaaaaaaaaa";
const PROJECT = "github.com/acme/app";

const passFrom = (from: string, over: Partial<Parameters<typeof mintSandboxPass>[1]> = {}): string =>
    mintSandboxPass(privateKey, { from, fromName: from === OPS ? "ops" : "other", to: SELF, project: PROJECT, issuedAtMs: Date.now(), ...over });

const fakeServices = (root: string, key: string | undefined): Services =>
    unstubbed<Services>("services", {
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        logger: unstubbed<Services["logger"]>("logger", { error: () => {}, warn: () => {}, info: () => {} }),
        members: memoryMembersStore([{ email: "ada@acme.test", tier: "collaborator" }]),
        ownerEmail: async () => "owner@acme.test",
        config: unstubbed<Services["config"]>("config", { connectToken: CONNECT_TOKEN, historyRoot: join(root, "history") }),
        platformIdentityKey: unstubbed<Services["platformIdentityKey"]>("platformIdentityKey", { settled: async () => key }),
    });

const problem = (over: Partial<AccountReport["report"]> = {}): AccountReport["report"] => ({
    kind: "detection",
    message: "GET /api/orders answered 500 for order 81231",
    ...over,
});

const setup = (options: { key?: string | undefined; filing?: Filing } = {}) => {
    const root = mkdtempSync(join(tmpdir(), "account-report-"));
    const services = fakeServices(root, "key" in options ? options.key : publicKey);
    const filed: AccountReportFiled[] = [];
    const routes = createAccountRoutes(services, {
        file: async (report) => {
            filed.push(report);
            return options.filing ?? { kind: "taken", id: `fire-${filed.length}` };
        },
    });
    const app = new Hono().post("/account/report", routes.report);
    const post = async (pass: string | undefined, body: unknown) => {
        const headers = new Headers({ "content-type": "application/json" });
        if (pass !== undefined) {
            headers.set(SANDBOX_PASS_HEADER, pass);
        }
        const res = await app.request("/account/report", { method: "POST", headers, body: JSON.stringify(body) });
        const answer: { id?: string; error?: string } = await res.json();
        return { status: res.status, ...answer };
    };
    return { services, filed, post };
};

test("a pass signed for this sandbox hands the report to the inbox, with the sender the pass names", async () => {
    const { filed, post } = setup();
    const answer = await post(passFrom(OPS), { report: problem(), conversationId: "brave-fox-1a2b", times: 3 });
    expect(answer).toMatchObject({ status: 200, id: "fire-1" });
    expect(filed).toEqual([
        { report: problem(), times: 3, sender: { sandboxId: OPS, sandboxName: "ops", project: PROJECT, conversationId: "brave-fox-1a2b" } },
    ]);
});

test("a report across an organisation's line carries the line the pass names", async () => {
    const { filed, post } = setup();
    const crossesOrg = { from: { id: "org_acme", name: "Acme" } };
    expect((await post(passFrom(OPS, { crossesOrg }), { report: problem() })).status).toBe(200);
    expect(filed[0]?.sender).toMatchObject({ sandboxId: OPS, crossesOrg });
    expect(filed[0]?.times).toBe(1);
});

// The sender's outbox keeps what is not taken and tries again for a week (account-outbox.ts): a 503 is "not now".
test("a report the inbox cannot take now is answered not now, saying why, so the sender keeps it", async () => {
    const { post } = setup({ filing: { kind: "later", why: "this sandbox has no issues inbox switched on (the Issues extension)" } });
    expect(await post(passFrom(OPS), { report: problem() })).toMatchObject({ status: 503, error: "this sandbox has no issues inbox switched on (the Issues extension)" });
});

test("with no extension keeping the issues inbox, the hand-off is not now rather than lost", async () => {
    const root = mkdtempSync(join(tmpdir(), "account-inbox-"));
    const filing = await fileWithInbox(
        {
            workspace: { root },
            files: { read: async () => undefined },
            capabilities: { list: async () => [] },
            config: unstubbed<Services["config"]>("config", { extensionsDir: join(root, "extensions"), historyRoot: join(root, "history") }),
            extensionBackend: unstubbed<Services["extensionBackend"]>("extensionBackend", {}),
            automations: unstubbed<Services["automations"]>("automations", {}),
            logger: unstubbed<Services["logger"]>("logger", {}),
        },
        { report: problem(), times: 1, sender: { sandboxId: OPS, sandboxName: "ops", project: PROJECT } },
        Date.now(),
    );
    expect(filing).toEqual({ kind: "later", why: "this sandbox has no issues inbox switched on (the Issues extension)" });
});

test("refuses a missing pass, a pass for another sandbox, another key's pass, an expired one, and an ungroupable body", async () => {
    const { post, filed } = setup();
    expect((await post(undefined, { report: problem() })).status).toBe(401);
    expect((await post(passFrom(OPS, { to: "cccccccccccc" }), { report: problem() })).status).toBe(401);
    const stranger = generateKeyPairSync("ed25519", { privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    const forged = mintSandboxPass(stranger.privateKey, { from: OPS, fromName: "ops", to: SELF, project: PROJECT, issuedAtMs: Date.now() });
    expect((await post(forged, { report: problem() })).status).toBe(401);
    expect((await post(passFrom(OPS, { issuedAtMs: Date.now() - 11 * 60_000 }), { report: problem() })).status).toBe(401);
    expect((await post(passFrom(OPS), { report: { kind: "report", message: "ungrouped words" } })).status).toBe(400);
    expect(filed).toEqual([]);
});

test("asks the sender to retry while this sandbox has not learned the platform's key", async () => {
    const { post } = setup({ key: undefined });
    expect((await post(passFrom(OPS), { report: problem() })).status).toBe(503);
});

test("a report pass naming a person this sandbox knows carries them on the sender, and one it does not know goes without", async () => {
    const { filed, post } = setup();
    expect((await post(passFrom(OPS, { person: "Ada@Acme.test" }), { report: problem() })).status).toBe(200);
    expect(filed[0]?.sender).toMatchObject({ sandboxId: OPS, person: "ada@acme.test" });
    expect((await post(passFrom(OPS, { person: "eve@elsewhere.test", project: "github.com/acme/site" }), { report: problem() })).status).toBe(200);
    expect(filed[1]?.sender).not.toHaveProperty("person");
    expect(filed[1]?.sender.project).toBe("github.com/acme/site");
});

test("a pass for another scope does not open the report door", async () => {
    const { post, filed } = setup();
    const drop = passFrom(OPS, { scope: "drop", project: undefined, person: "ada@acme.test" });
    expect((await post(drop, { report: problem() })).status).toBe(401);
    expect(filed).toEqual([]);
});
