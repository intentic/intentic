import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXTENSION_SIGN_PER_MINUTE, ExtensionIdentitySignedSchema } from "@intentic/sandbox-contract/extension-protocol";
import { EXTENSION_TOKEN_HEADER } from "@intentic/sandbox-contract/headers";
import { EXTENSION_SIGN_PAYLOAD_MAX_BYTES, SIGN_DOMAINS, verifyExtensionPayload, verifyIdentity } from "@intentic/sandbox-contract/s2s";
import { SandboxIdentitySchema } from "@intentic/sandbox-contract/schemas/s2s";
import { unstubbed } from "@intentic/testing";
import { Hono } from "hono";
import type { ExtensionGrant } from "../../auth/grants.js";
import { memorySecretVault } from "../../capabilities/capabilities-slice.testing.js";
import type { Services } from "../../composition.js";
import { testConfig } from "../../env.config.testing.js";
import { createS2sIdentity } from "../../s2s/identity/s2s-identity.js";
import { readWorkspaceFile } from "../../workspace/files/workspace-files.js";
import { createExtensionIdentityDoors } from "./own-identity.js";
import { ownCaller } from "./own.routes.js";

// (2026-11-28) The identity doors an extension's own code reaches (own-identity.ts), over a baked extensions tree of two:
// one declaring `permissions.identity: ["sign"]`, one declaring nothing. The identity is the daemon's own service on
// temp files, so what is signed is checked against the document it publishes.

const MANIFEST = { version: "1.0.0", engines: { intentic: "^2.60.0" }, server: "dist/server.js" };
const GRANTS = new Map<string, ExtensionGrant>([
    ["network-token", { id: "acme.network", permissions: [] }],
    ["plain-token", { id: "acme.plain", permissions: [] }],
]);

const setup = () => {
    const root = mkdtempSync(join(tmpdir(), "extension-identity-"));
    const extensionsDir = join(root, "extensions");
    const write = (name: string, manifest: object): void => {
        mkdirSync(join(extensionsDir, name), { recursive: true });
        writeFileSync(join(extensionsDir, name, "intentic-extension.json"), JSON.stringify({ publisher: "acme", name, ...MANIFEST, ...manifest }));
    };
    write("network", { permissions: { identity: ["sign"] } });
    write("plain", {});
    const clock = { now: 1_764_288_000_000 };
    const s2sIdentity = createS2sIdentity({
        keysPath: join(root, "auth", "sandbox-identity.json"),
        domainsPath: join(root, "history", "s2s-domains.json"),
        attestationsPath: join(root, "history", "s2s", "identity-attestations.json"),
        self: () => ({ sandbox: "sbx-1", name: "Ops", host: "sbx-1.intentic.app" }),
        resolveTxt: async () => ({ kind: "missing" }),
        now: () => clock.now,
    });
    const debug: object[] = [];
    const services = unstubbed<Services>("services", {
        config: { ...testConfig, extensionsDir, historyRoot: join(root, "history") },
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        files: unstubbed<Services["files"]>("files", { read: readWorkspaceFile }),
        capabilities: unstubbed<Services["capabilities"]>("capabilities", { list: async () => [] }),
        extensionSecretVault: memorySecretVault(),
        extensionBackend: unstubbed<Services["extensionBackend"]>("extensionBackend", { verifyExtensionToken: (presented) => GRANTS.get(presented) }),
        logger: unstubbed<Services["logger"]>("logger", { debug: (fields: object) => void debug.push(fields) }),
        s2sIdentity,
    });
    const doors = createExtensionIdentityDoors(services, (c) => ownCaller(services, c), () => clock.now);
    const app = new Hono().get("/extension/identity", doors.document).post("/extension/identity/sign", doors.sign);
    return { app, s2sIdentity, clock, debug };
};

const as = (token: string, body: string | null = null): RequestInit => ({
    method: body === null ? "GET" : "POST",
    body,
    headers: { [EXTENSION_TOKEN_HEADER]: token, "content-type": "application/json" },
});

const RECORD = { "@context": "https://schema.org", "@type": "Article", headline: "Hello", datePublished: "2026-11-28" };

describe("GET /extension/identity", () => {
    test("answers any installed extension the sandbox's public document, signed, and nobody without a token", async () => {
        const { app, s2sIdentity } = setup();
        const answer = await app.request("/extension/identity", as("plain-token"));
        expect(answer.status).toBe(200);
        const document = SandboxIdentitySchema.parse(await answer.json());
        expect(document).toEqual(await s2sIdentity.document());
        expect(verifyIdentity(document)).toEqual({ ok: true });
        expect((await app.request("/extension/identity")).status).toBe(403);
    });
});

describe("POST /extension/identity/sign", () => {
    test("is refused to an extension whose manifest does not declare permissions.identity sign", async () => {
        const { app } = setup();
        const refused = await app.request("/extension/identity/sign", as("plain-token", JSON.stringify({ purpose: "log.entry", payload: RECORD })));
        expect(refused.status).toBe(403);
        expect(await refused.json()).toEqual({ error: `extension "acme.plain" did not declare permissions.identity ["sign"], so it signs nothing as this sandbox` });
    });

    test("signs a declared extension's record as this sandbox, verifiable with the document's keys and nothing else", async () => {
        const { app, debug } = setup();
        const answer = await app.request("/extension/identity/sign", as("network-token", JSON.stringify({ purpose: "log.entry", payload: RECORD })));
        expect(answer.status).toBe(200);
        const signed = ExtensionIdentitySignedSchema.parse(await answer.json());
        expect(signed.domain).toBe("ext:acme.network/log.entry");
        expect(signed.fingerprint).toBe(signed.document.fingerprint);
        expect(verifyIdentity(signed.document)).toEqual({ ok: true });
        expect(verifyExtensionPayload("acme.network", "log.entry", RECORD, signed.sig, signed.document.keys)).toBe(true);
        // The extension is the one its token names, never one it could claim, and the purpose is part of what is signed.
        expect(verifyExtensionPayload("acme.plain", "log.entry", RECORD, signed.sig, signed.document.keys)).toBe(false);
        expect(verifyExtensionPayload("acme.network", "log.other", RECORD, signed.sig, signed.document.keys)).toBe(false);
        expect(verifyExtensionPayload("acme.network", "log.entry", { ...RECORD, headline: "Hullo" }, signed.sig, signed.document.keys)).toBe(false);
        expect(debug).toEqual([{ extension: "acme.network", domain: "ext:acme.network/log.entry", bytes: expect.any(Number) }]);
    });

    test("refuses a body that is not JSON, a payload missing, and a purpose outside its pattern", async () => {
        const { app } = setup();
        const notJson = await app.request("/extension/identity/sign", as("network-token", "{ purpose: log.entry, payload: [1, 2"));
        expect(notJson.status).toBe(400);
        expect(await notJson.json()).toEqual({ error: "not a record to sign: the body is { purpose, payload }, the payload any JSON value" });
        expect((await app.request("/extension/identity/sign", as("network-token", JSON.stringify({ purpose: "log.entry" })))).status).toBe(400);
        const purpose = await app.request("/extension/identity/sign", as("network-token", JSON.stringify({ purpose: "Log/Entry", payload: RECORD })));
        expect(purpose.status).toBe(400);
        expect(await purpose.json()).toEqual({ error: `"Log/Entry" is not a signing purpose: a lowercase word of up to 64 characters, dots and dashes inside` });
    });

    test("refuses a record past the cap of canonical bytes", async () => {
        const { app } = setup();
        const big = { blob: "x".repeat(EXTENSION_SIGN_PAYLOAD_MAX_BYTES) };
        const refused = await app.request("/extension/identity/sign", as("network-token", JSON.stringify({ purpose: "log.entry", payload: big })));
        expect(refused.status).toBe(413);
        const fits = { blob: "x".repeat(EXTENSION_SIGN_PAYLOAD_MAX_BYTES - 20) };
        expect((await app.request("/extension/identity/sign", as("network-token", JSON.stringify({ purpose: "log.entry", payload: fits })))).status).toBe(200);
    });

    test("answers 429 with Retry-After past the minute's count, and signs again in the next minute", async () => {
        const { app, s2sIdentity, clock } = setup();
        // The count is the door's; signing itself is the identity service's, so the minute is filled without paying for it.
        const sign = s2sIdentity.sign;
        Object.assign(s2sIdentity, { sign: async () => ({ ed25519: "", mldsa65: "" }) });
        const body = JSON.stringify({ purpose: "log.entry", payload: RECORD });
        for (let made = 0; made < EXTENSION_SIGN_PER_MINUTE; made++) {
            expect((await app.request("/extension/identity/sign", as("network-token", body))).status).toBe(200);
        }
        clock.now += 15_000;
        const refused = await app.request("/extension/identity/sign", as("network-token", body));
        expect(refused.status).toBe(429);
        expect(refused.headers.get("retry-after")).toBe("45");
        Object.assign(s2sIdentity, { sign });
        clock.now += 45_000;
        expect((await app.request("/extension/identity/sign", as("network-token", body))).status).toBe(200);
    });

    test("after a rotation, signs with the new key the document it answers names", async () => {
        const { app, s2sIdentity } = setup();
        const before = (await s2sIdentity.document()).fingerprint;
        await s2sIdentity.rotate();
        const signed = ExtensionIdentitySignedSchema.parse(
            await (await app.request("/extension/identity/sign", as("network-token", JSON.stringify({ purpose: "log.entry", payload: RECORD })))).json(),
        );
        expect(signed.fingerprint).not.toBe(before);
        expect(verifyExtensionPayload("acme.network", "log.entry", RECORD, signed.sig, signed.document.keys)).toBe(true);
        expect(SIGN_DOMAINS).not.toContain(signed.domain);
    });
});
