import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import { stashedMarker } from "@intentic/sandbox-contract/schemas/capabilities";
import { unstubbed } from "@intentic/testing";
import { Hono } from "hono";
import type { AppEnv } from "../../app-env.js";
import type { CapabilityCtx } from "../capability.js";
import { memoryCapabilitiesStore } from "../capabilities-slice.testing.js";
import { createSecretStash, unstash } from "../credentials/secret-stash.js";
import { mcpHandler } from "../handlers/mcp.handler.js";
import { type FakeOAuthMcp, startFakeOAuthMcp } from "./mcp-oauth.testing.js";
import { createMcpCallbackRoute } from "./mcp-sign-in.routes.js";
import { waitMcpSignIn } from "./mcp-sign-in.handlers.js";
import { createMcpSignIns, MCP_CALLBACK_PATH, type McpSignIns } from "./mcp-sign-ins.js";
import { encodeMcpSession, type McpSession, mcpSessionOf } from "./mcp-session.js";

// The MCP sign-in against a real HTTP authorization server and MCP server on loopback (mcp-oauth.testing.ts): discovery,
// registration, the authorization request, the landing's checks, the code's trade and the session's upkeep. Real
// sockets, since headers, redirects and form bodies are what the spec is about.

const CALLBACK_BASE = "https://sandbox-test.sbx.example";
const servers: FakeOAuthMcp[] = [];

afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
});

const fake = async (options?: Parameters<typeof startFakeOAuthMcp>[0]): Promise<FakeOAuthMcp> => {
    const server = await startFakeOAuthMcp(options);
    servers.push(server);
    return server;
};

const signInsOver = (initial: Capability[] = [], now: () => number = Date.now) => {
    const store = memoryCapabilitiesStore(initial);
    const logger = { warn: () => {} };
    return { signIns: createMcpSignIns({ store, callbackBase: () => CALLBACK_BASE, clientName: () => "Intentic (test)", logger, now }), store };
};

// Signs in end to end, the person approving at once; answers the session the form would be handed.
const signedIn = async (server: FakeOAuthMcp, signIns: McpSignIns): Promise<McpSession> => {
    const started = await signIns.begin({ url: server.url });
    const landed = await signIns.land(server.approve(started.authorizeUrl).searchParams);
    expect(landed.ok).toBe(true);
    const outcome = await signIns.wait(started.flow);
    if (outcome.state !== "done") {
        throw new Error(`sign-in did not finish: ${JSON.stringify(outcome)}`);
    }
    return outcome.session;
};

test("check tells an open server, one that takes a token, one with a sign-in, and one that does not answer apart", async () => {
    const oauth = await fake();
    const { signIns } = signInsOver();
    expect(await signIns.check(oauth.url)).toEqual({ auth: "oauth", server: "Fake MCP", registers: true, redirectUri: `${CALLBACK_BASE}${MCP_CALLBACK_PATH}` });
    // Answered without a credential: the metadata endpoints answer 200 to a POST-less GET, so the server's root reads open.
    expect(await signIns.check(`${oauth.origin}/.well-known/oauth-protected-resource/mcp`)).toEqual({ auth: "open" });
    await oauth.close();
    servers.splice(0);
    expect((await signIns.check(oauth.url)).auth).toBe("unreachable");
});

test("a sign-in registers the sandbox, sends the person with PKCE, state and resource, and trades the code it lands with", async () => {
    const server = await fake();
    const { signIns } = signInsOver();
    const started = await signIns.begin({ url: server.url });

    expect(started.redirectUri).toBe(`${CALLBACK_BASE}${MCP_CALLBACK_PATH}`);
    expect(started.server).toBe("Fake MCP");
    // Registered as a public web client with the one callback it lands on, and allowed to renew.
    expect(server.registrations).toEqual([
        {
            client_name: "Intentic (test)",
            redirect_uris: [`${CALLBACK_BASE}${MCP_CALLBACK_PATH}`],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
            application_type: "web",
        },
    ]);
    const asked = new URL(started.authorizeUrl);
    expect(`${asked.origin}${asked.pathname}`).toBe(`${server.origin}/authorize`);
    expect(Object.fromEntries([...asked.searchParams].filter(([key]) => !["state", "code_challenge"].includes(key)))).toEqual({
        response_type: "code",
        client_id: "client-1",
        redirect_uri: `${CALLBACK_BASE}${MCP_CALLBACK_PATH}`,
        code_challenge_method: "S256",
        resource: server.url,
        // The challenge's scope, then what the authorization server offers for renewal and for saying who signed in.
        scope: "read offline_access openid email",
    });
    expect(asked.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/);

    const landed = await signIns.land(server.approve(started.authorizeUrl).searchParams);
    expect(landed).toEqual({ ok: true, message: "Signed in to Fake MCP. You can close this window and go back to Intentic." });
    const outcome = await signIns.wait(started.flow);
    expect(outcome).toMatchObject({
        state: "done",
        session: {
            mcpOAuth: 1,
            issuer: server.origin,
            server: "Fake MCP",
            clientId: "client-1",
            clientAuth: "none",
            resource: server.url,
            accessToken: "at-1",
            refreshToken: "rt-1",
            scope: "read offline_access openid email",
            account: "ada@example.com",
        },
    });
    // Handed over once: a second wait finds it gone rather than a second copy.
    expect(await signIns.wait(started.flow)).toMatchObject({ state: "failed" });
});

test("a landing is acted on only for a sign-in started here, once, and from the issuer it was started with", async () => {
    const server = await fake();
    const { signIns } = signInsOver();
    const started = await signIns.begin({ url: server.url });
    const back = server.approve(started.authorizeUrl);
    const tokenCalls = (): number => server.seen.filter((request) => request.path === "/token").length;

    // A state nobody started: nothing is traded, and the real sign-in still waits.
    const forged = new URLSearchParams(back.searchParams);
    forged.set("state", "not-ours");
    expect((await signIns.land(forged)).ok).toBe(false);
    expect(tokenCalls()).toBe(0);

    // An answer naming another issuer (a mix-up): refused before its code is sent anywhere, and the sign-in ends.
    const mixed = new URLSearchParams(back.searchParams);
    mixed.set("iss", "https://attacker.example");
    expect(await signIns.land(mixed)).toEqual({
        ok: false,
        message: "The answer did not come from Fake MCP, the authorization server this sign-in was started with. Sign in again. You can close this window.",
    });
    expect(tokenCalls()).toBe(0);
    expect(await signIns.wait(started.flow)).toEqual({
        state: "failed",
        message: "The answer did not come from Fake MCP, the authorization server this sign-in was started with. Sign in again.",
    });

    // Its state is spent: the genuine answer arriving afterwards finds nothing either.
    expect((await signIns.land(back.searchParams)).ok).toBe(false);
    expect(tokenCalls()).toBe(0);
});

test("an answer missing the iss its server promised is refused, and a declined consent says so", async () => {
    const server = await fake();
    const { signIns } = signInsOver();
    const first = await signIns.begin({ url: server.url });
    const stripped = server.approve(first.authorizeUrl).searchParams;
    stripped.delete("iss");
    expect((await signIns.land(stripped)).ok).toBe(false);

    const second = await signIns.begin({ url: server.url });
    await signIns.land(server.approve(second.authorizeUrl, { error: "access_denied" }).searchParams);
    expect(await signIns.wait(second.flow)).toEqual({ state: "failed", message: "The sign-in was cancelled at Fake MCP." });
});

test("protected-resource metadata is found at its well-known address, or the server's own origin serves as its authorization server", async () => {
    const wellKnown = await fake({ metadata: "well-known" });
    const bare = await fake({ metadata: "none" });
    const { signIns } = signInsOver();
    expect(await signIns.check(wellKnown.url)).toEqual({ auth: "oauth", server: "Fake MCP", registers: true, redirectUri: `${CALLBACK_BASE}${MCP_CALLBACK_PATH}` });
    // No metadata at all: named by the issuer's host, and asked only the challenge's scope plus what it offers.
    const started = await signIns.begin({ url: bare.url });
    expect(started.server).toBe(new URL(bare.origin).host);
    expect(new URL(started.authorizeUrl).searchParams.get("resource")).toBe(bare.url);
});

test("an authorization server that registers nobody needs a client ID, which is then used as given", async () => {
    const server = await fake({ registration: false });
    const { signIns } = signInsOver();
    expect(await signIns.check(server.url)).toEqual({ auth: "oauth", server: "Fake MCP", registers: false, redirectUri: `${CALLBACK_BASE}${MCP_CALLBACK_PATH}` });
    await expect(signIns.begin({ url: server.url })).rejects.toThrow(
        `${new URL(server.origin).host} does not register clients by itself: make an OAuth client in its own settings with ${CALLBACK_BASE}${MCP_CALLBACK_PATH} as its redirect address, and enter its client ID`,
    );
    const started = await signIns.begin({ url: server.url, clientId: "made-by-hand" });
    expect(new URL(started.authorizeUrl).searchParams.get("client_id")).toBe("made-by-hand");
    expect(server.registrations).toEqual([]);
});

test("reconnecting a connection reuses the client it registered at the same authorization server", async () => {
    const server = await fake();
    const { signIns, store } = signInsOver();
    const session = await signedIn(server, signIns);
    await store.upsert({ id: "fake", kind: "mcp", config: { url: server.url, token: encodeMcpSession(session) } });
    const again = await signIns.begin({ url: server.url, keeping: "fake" });
    expect(new URL(again.authorizeUrl).searchParams.get("client_id")).toBe("client-1");
    expect(server.registrations).toHaveLength(1);
});

test("a finished sign-in reaches the form as a stash token the add trades for the session, and never as the session", async () => {
    const server = await fake();
    const { signIns } = signInsOver();
    const stash = createSecretStash();
    const started = await signIns.begin({ url: server.url });
    await signIns.land(server.approve(started.authorizeUrl).searchParams);
    const answer = await waitMcpSignIn(signIns, stash, started.flow);
    expect(answer).toEqual({ state: "done", token: expect.any(String), server: "Fake MCP", account: "ada@example.com", scope: "read offline_access openid email" });
    expect(JSON.stringify(answer)).not.toContain("at-1");
    if (answer.state !== "done") {
        return;
    }
    const installed = unstash(stash, "mcp", { url: server.url, token: stashedMarker(answer.token) });
    expect(mcpSessionOf(installed["token"])).toMatchObject({ accessToken: "at-1", refreshToken: "rt-1" });
});

test("a bearer is renewed when it is about to lapse, written back rotated, and a refused renewal asks for a new sign-in", async () => {
    const server = await fake({ accessTtl: 30 });
    let clock = 1_000_000;
    const { signIns, store } = signInsOver([], () => clock);
    const session = await signedIn(server, signIns);
    // Thirty seconds of life is inside the renewal margin, so even the first use renews.
    await store.upsert({ id: "fake", kind: "mcp", config: { url: server.url, token: encodeMcpSession(session) } });
    expect(await signIns.bearer("fake")).toEqual({ bearer: "at-2" });
    const stored = await store.get("fake");
    expect(mcpSessionOf(stored?.kind === "mcp" ? stored.config.token : undefined)).toMatchObject({
        accessToken: "at-2",
        refreshToken: "rt-2",
        expiresAt: clock + 30_000,
    });
    clock += 60_000;
    server.refuseRenewals();
    expect(await signIns.bearer("fake")).toEqual({ signIn: "Fake MCP no longer accepts the saved sign-in (invalid_grant: refresh token revoked): sign in again." });
    // A pasted token is the bearer as it is, and a card without one sends none.
    await store.upsert({ id: "pasted", kind: "mcp", config: { url: server.url, token: " tok \n" } });
    await store.upsert({ id: "bare", kind: "mcp", config: { url: server.url } });
    expect(await signIns.bearer("pasted")).toEqual({ bearer: "tok" });
    expect(await signIns.bearer("bare")).toEqual({ bearer: undefined });
});

test("two requests needing a renewal at once spend the refresh token once", async () => {
    const server = await fake({ accessTtl: 10 });
    const { signIns, store } = signInsOver();
    const session = await signedIn(server, signIns);
    await store.upsert({ id: "fake", kind: "mcp", config: { url: server.url, token: encodeMcpSession(session) } });
    expect(await Promise.all([signIns.bearer("fake"), signIns.bearer("fake")])).toEqual([{ bearer: "at-2" }, { bearer: "at-2" }]);
    expect(server.seen.filter((request) => request.path === "/token")).toHaveLength(2);
});

test("the card's status says needs sign-in apart from unreachable, and saving a server that asks for one without it is refused", async () => {
    const server = await fake();
    const { signIns, store } = signInsOver();
    const ctx = unstubbed<CapabilityCtx>("ctx", { mcpSignIns: signIns });
    const session = await signedIn(server, signIns);
    const token = encodeMcpSession(session);
    await store.upsert({ id: "fake", kind: "mcp", config: { url: server.url, token } });
    expect(await mcpHandler.status(ctx, "fake", { url: server.url, token })).toEqual({ state: "active" });
    // Revoked at the server and not renewable: the card asks for a sign-in rather than calling the server down.
    server.validAccess.clear();
    server.refuseRenewals();
    expect(await mcpHandler.status(ctx, "fake", { url: server.url, token })).toEqual({
        state: "pending",
        detail: "Fake MCP no longer accepts the saved sign-in (invalid_grant: refresh token revoked): sign in again.",
    });
    expect(await mcpHandler.status(ctx, "bare", { url: server.url })).toEqual({
        state: "pending",
        detail: "Fake MCP asks you to sign in: open this connection and press Sign in.",
    });
    const save = async (): Promise<void> => {
        for await (const line of mcpHandler.apply(ctx, "bare", { url: server.url })) {
            void line;
        }
    };
    await expect(save()).rejects.toThrow("Fake MCP asks you to sign in first: press Sign in on the form, then save.");
    await server.close();
    servers.splice(0);
    expect(await mcpHandler.status(ctx, "fake", { url: server.url, token: "pasted" })).toEqual({ state: "error", detail: "unreachable" });
    // The list echoes where and as whom it signed in, and nothing of the session itself.
    expect(mcpHandler.echo({ url: server.url, token }, new Map())).toEqual({
        url: server.url,
        hasToken: true,
        signedIn: true,
        signInServer: "Fake MCP",
        account: "ada@example.com",
        scope: "read offline_access openid email",
    });
});

test("the callback page tells the browser how it ended, never cached, and the code never leaves its address bar's history", async () => {
    const server = await fake();
    const { signIns } = signInsOver();
    const app = new Hono<AppEnv>().get(MCP_CALLBACK_PATH, createMcpCallbackRoute(signIns));
    const started = await signIns.begin({ url: server.url });
    const back = server.approve(started.authorizeUrl);

    const landed = await app.request(`${MCP_CALLBACK_PATH}${back.search}`);
    expect(landed.status).toBe(200);
    expect(landed.headers.get("cache-control")).toBe("no-store");
    const page = await landed.text();
    expect(page).toContain("Signed in to Fake MCP. You can close this window and go back to Intentic.");
    expect(page).toContain(`history.replaceState(null, "", location.pathname);`);

    const replayed = await app.request(`${MCP_CALLBACK_PATH}${back.search}`);
    expect(replayed.status).toBe(400);
    expect(await replayed.text()).toContain("This sign-in was not started here, or it already finished or lapsed.");
});
