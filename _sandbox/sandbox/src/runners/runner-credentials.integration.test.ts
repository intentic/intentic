import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import type { RunnerCredential } from "@intentic/sandbox-contract";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Services } from "../composition.js";
import { createRunnerTranslatorProxyRoute, toRunnerCredential } from "./runner-credentials.routes.js";
import { parentCredentialSource } from "./runner-credentials.js";
import type { RunnerIdentity } from "./runner-identity.js";

const TOKEN = "irt_test";
const quiet = { warn: () => undefined, info: () => undefined };

/* THE TRAVEL RULE, arm by arm: toRunnerCredential is every decision about what may leave the parent, so each
 * arm is pinned as a fact rather than trusted to survive a refactor. */
describe("toRunnerCredential", () => {
    const TRANSLATOR = "http://127.0.0.1:8317";

    it("turns the parent's own translator endpoint into a route, never a credential", () => {
        const mapped = toRunnerCredential(
            { ok: true, credentials: { endpoint: { baseUrl: TRANSLATOR, authToken: "local-secret", model: "gpt-5" } } },
            TRANSLATOR,
            "",
        );
        expect(mapped).toEqual({ ok: true, kind: "parent-translator", model: "gpt-5" });
        // The translator's local bearer must not be in the answer in any shape.
        expect(JSON.stringify(mapped)).not.toContain("local-secret");
    });

    it("passes a foreign endpoint through whole, bearer included — the runner dials it directly", () => {
        expect(
            toRunnerCredential(
                { ok: true, credentials: { endpoint: { baseUrl: "https://api.example.com", authToken: "sk-x", model: "m" } } },
                TRANSLATOR,
                "",
            ),
        ).toEqual({ ok: true, kind: "endpoint", baseUrl: "https://api.example.com", authToken: "sk-x", model: "m" });
    });

    it("forwards a stored account's access token with its account, so the refresh door can name it", () => {
        expect(toRunnerCredential({ ok: true, credentials: { oauthToken: "at-1", account: "a@b" } }, TRANSLATOR, "")).toEqual({
            ok: true,
            kind: "oauth",
            accessToken: "at-1",
            account: "a@b",
        });
    });

    it("the env fallback travels as an oauth value with no account — nothing to rotate", () => {
        expect(toRunnerCredential({ ok: true, credentials: {} }, TRANSLATOR, "env-oauth")).toEqual({
            ok: true,
            kind: "oauth",
            accessToken: "env-oauth",
        });
        // And with no env either, the answer is a refusal that names the fix, never a half-working turn.
        const refused = toRunnerCredential({ ok: true, credentials: {} }, TRANSLATOR, "");
        expect(refused.ok).toBe(false);
    });

    it("refusals pass through with their codes, so remote connect gates read like local ones", () => {
        expect(toRunnerCredential({ ok: false, code: "claude-reauth", message: "reconnect" }, TRANSLATOR, "")).toEqual({
            ok: false,
            code: "claude-reauth",
            message: "reconnect",
        });
    });
});

/* The runner side against a stub parent: what each answer kind becomes, that the refresh hook re-mints at
 * the parent with the superseded token named, and that the runner's own token authenticates every call. */
describe("parentCredentialSource", () => {
    let server: ServerType;
    let identity: RunnerIdentity;
    let nextAnswer: RunnerCredential;
    const seen: { auth?: string | undefined; refreshBody?: unknown } = {};

    beforeAll(() => {
        const app = new Hono();
        app.post("/system/runners/credentials", (c) => {
            seen.auth = c.req.header("authorization");
            return c.json(nextAnswer);
        });
        app.post("/system/runners/credentials/refresh", async (c) => {
            seen.refreshBody = await c.req.json();
            return c.json({ accessToken: "at-2" });
        });
        server = serve({ fetch: app.fetch, port: 0 });
        const port = (server.address() as AddressInfo).port;
        identity = { parentUrl: `http://127.0.0.1:${port}`, id: "r", token: TOKEN, enrolledAt: 0 };
    });
    afterAll(() => {
        server.close();
    });

    it("an oauth answer carries the token, the account, and a refresh hook that re-mints at the parent", async () => {
        nextAnswer = { ok: true, kind: "oauth", accessToken: "at-1", account: "a@b" };
        const resolved = await parentCredentialSource(identity, quiet).resolve({ agent: "claude" });
        expect(seen.auth).toBe(`Bearer ${TOKEN}`);
        if (!resolved.ok) {
            throw new Error(resolved.message);
        }
        expect(resolved.credentials.oauthToken).toBe("at-1");
        expect(resolved.credentials.account).toBe("a@b");
        const minted = await resolved.credentials.refreshOauthToken?.({ signal: new AbortController().signal });
        expect(minted).toBe("at-2");
        expect(seen.refreshBody).toEqual({ account: "a@b", rejected: "at-1" });
    });

    it("a parent-translator answer becomes the proxy URL with the runner's OWN token as the bearer", async () => {
        nextAnswer = { ok: true, kind: "parent-translator", model: "gpt-5", trial: true };
        const resolved = await parentCredentialSource(identity, quiet).resolve({ agent: "codex" });
        if (!resolved.ok) {
            throw new Error(resolved.message);
        }
        expect(resolved.credentials.endpoint).toEqual({
            baseUrl: `${identity.parentUrl}/system/runners/translator`,
            authToken: TOKEN,
            model: "gpt-5",
        });
        expect(resolved.credentials.trial).toBe(true);
    });

    it("a refusal arrives as the same value a local resolution would produce", async () => {
        nextAnswer = { ok: false, code: "subscription-required", message: "connect it" };
        const resolved = await parentCredentialSource(identity, quiet).resolve({ agent: "grok" });
        expect(resolved).toEqual({ ok: false, code: "subscription-required", message: "connect it" });
    });

    it("an unreachable parent throws, which is the caller's cue to fall back to local accounts", async () => {
        const dead = { ...identity, parentUrl: "http://127.0.0.1:9" };
        await expect(parentCredentialSource(dead, quiet).resolve({})).rejects.toThrow();
    });
});

/* The translator proxy: the bearer swap is the whole security story — the runner's token in, the local one
 * out, and nothing through the door without one. */
describe("translator proxy", () => {
    let upstream: ServerType;
    let proxy: ServerType;
    let proxyUrl: string;
    let upstreamSaw: { path?: string; auth?: string | undefined; body?: unknown };

    beforeAll(() => {
        upstreamSaw = {};
        const translator = new Hono();
        translator.post("/v1/messages", async (c) => {
            upstreamSaw = { path: c.req.path, auth: c.req.header("authorization"), body: await c.req.json() };
            return c.json({ answered: true });
        });
        upstream = serve({ fetch: translator.fetch, port: 0 });
        const translatorUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
        const services = {
            config: { translator: { url: translatorUrl, token: "local-secret" } },
            runners: { verify: async (presented: string) => (presented === TOKEN ? "r" : undefined) },
            logger: quiet,
        } as unknown as Services;
        const app = new Hono();
        app.all("/system/runners/translator/*", createRunnerTranslatorProxyRoute(services));
        proxy = serve({ fetch: app.fetch, port: 0 });
        proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    });
    afterAll(() => {
        upstream.close();
        proxy.close();
    });

    it("swaps the runner's bearer for the translator's and forwards path and body", async () => {
        const response = await fetch(`${proxyUrl}/system/runners/translator/v1/messages`, {
            method: "POST",
            headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
            body: JSON.stringify({ model: "gpt-5" }),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ answered: true });
        expect(upstreamSaw.path).toBe("/v1/messages");
        expect(upstreamSaw.auth).toBe("Bearer local-secret");
        expect(upstreamSaw.body).toEqual({ model: "gpt-5" });
    });

    it("no valid runner token, no door", async () => {
        const response = await fetch(`${proxyUrl}/system/runners/translator/v1/messages`, {
            method: "POST",
            headers: { authorization: "Bearer wrong" },
            body: "{}",
        });
        expect(response.status).toBe(401);
    });
});
