import { unstubbed } from "@intentic/testing";
import { Hono } from "hono";
import { createTurnMounts } from "../../agent/tools/turn-mounts.js";
import { createTurnMountRoute, type MountEndpoints } from "../../agent/tools/turn-mounts.routes.js";
import type { AppEnv } from "../../app-env.js";
import { memoryCapabilitiesStore } from "../capabilities-slice.testing.js";
import { mcpToolsOf } from "../mcp-tools.js";
import { type FakeOAuthMcp, startFakeOAuthMcp } from "./mcp-oauth.testing.js";
import { createMcpRemoteEndpoint } from "./mcp-remote.js";
import { createMcpSignIns } from "./mcp-sign-ins.js";
import { encodeMcpSession, mcpSessionOf } from "./mcp-session.js";

// A signed-in MCP server as a turn reaches it: mounted on the turn's lease, so the agent holds the turn's bearer and the
// door attaches the connection's access token, renewing it when due or when the server refuses it. Against a real
// loopback server (mcp-oauth.testing.ts), since what is forwarded is headers and bodies.

let server: FakeOAuthMcp | undefined;

afterEach(async () => {
    await server?.close();
    server = undefined;
});

// A connection signed in through the sandbox, its turn's lease, and the door the turn's tools point at.
const signedInTurn = async (accessTtl: number) => {
    const fake = await startFakeOAuthMcp({ accessTtl });
    server = fake;
    const store = memoryCapabilitiesStore();
    const signIns = createMcpSignIns({ store, callbackBase: () => "https://sandbox-test.sbx.example", clientName: () => "Intentic", logger: { warn: () => {} } });
    const started = await signIns.begin({ url: fake.url });
    await signIns.land(fake.approve(started.authorizeUrl).searchParams);
    const outcome = await signIns.wait(started.flow);
    if (outcome.state !== "done") {
        throw new Error("the sign-in did not finish");
    }
    await store.upsert({ id: "tracker", kind: "mcp", config: { url: fake.url, token: encodeMcpSession(outcome.session) } });
    await store.upsert({ id: "pasted", kind: "mcp", config: { url: "https://pasted.example/mcp", token: "tok-pasted" } });
    const mounts = createTurnMounts({ baseUrl: () => "http://127.0.0.1:1/mcp" });
    const lease = mounts.lease("conversation-1");
    const tools = mcpToolsOf(await store.list(), lease);
    const remote = createMcpRemoteEndpoint({ capabilities: store, bearer: signIns.bearer });
    const app = new Hono<AppEnv>().all("/mcp/:mount", createTurnMountRoute(mounts, unstubbed<MountEndpoints>("endpoints", { remote })));
    const turnBearer = tools.find((tool) => tool.name === "tracker")?.token ?? "";
    const call = () =>
        app.request("/mcp/tracker", {
            method: "POST",
            headers: { authorization: `Bearer ${turnBearer}`, "content-type": "application/json", "mcp-session-id": "s-1" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }),
        });
    return { fake, store, tools, turnBearer, call, lease };
};

test("a signed-in server is mounted on the turn's door, and a pasted token's server is reached at its own address", async () => {
    const { tools, turnBearer } = await signedInTurn(3600);
    expect(tools).toEqual([
        { name: "tracker", url: "http://127.0.0.1:1/mcp/tracker", token: turnBearer },
        { name: "pasted", url: "https://pasted.example/mcp", token: "tok-pasted" },
    ]);
    // Without a lease (the daemon's own calls) the access token rides as it stands, never the session around it.
    expect(mcpToolsOf([{ id: "tracker", kind: "mcp", config: { url: "https://x.example/mcp", token: encodeMcpSession({ ...placeholderSession(), accessToken: "at-9" }) } }])).toEqual([
        { name: "tracker", url: "https://x.example/mcp", token: "at-9" },
    ]);
});

test("the door forwards the whole request with the connection's own bearer, never the turn's", async () => {
    const { fake, call, turnBearer } = await signedInTurn(3600);
    const answered = await call();
    expect(answered.status).toBe(200);
    expect(answered.headers.get("mcp-session-id")).toBe("s-1");
    expect(await answered.json()).toEqual({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "fake" } } });
    const forwarded = fake.seen.findLast((request) => request.path === "/mcp");
    expect(forwarded).toEqual({ method: "POST", path: "/mcp", auth: "Bearer at-1", body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }) });
    expect(JSON.stringify(fake.seen)).not.toContain(turnBearer);
});

test("a lapsing token is renewed before the request, and one the server refuses is renewed and the request sent again", async () => {
    const lapsing = await signedInTurn(30);
    expect((await lapsing.call()).status).toBe(200);
    expect(lapsing.fake.seen.findLast((request) => request.path === "/mcp")?.auth).toBe("Bearer at-2");
    await lapsing.fake.close();
    server = undefined;

    const revoked = await signedInTurn(3600);
    revoked.fake.validAccess.delete("at-1");
    expect((await revoked.call()).status).toBe(200);
    // After the sign-in's own unauthenticated discovery call: the refused bearer, then the renewed one.
    expect(revoked.fake.seen.filter((request) => request.path === "/mcp").map((request) => request.auth)).toEqual([undefined, "Bearer at-1", "Bearer at-2"]);
    const stored = await revoked.store.get("tracker");
    expect(mcpSessionOf(stored?.kind === "mcp" ? stored.config.token : undefined)).toMatchObject({ accessToken: "at-2", refreshToken: "rt-2" });
});

test("a sign-in the server no longer honours answers the agent with why, and nothing after the turn ends", async () => {
    const { fake, call, lease } = await signedInTurn(3600);
    fake.validAccess.clear();
    fake.refuseRenewals();
    const refused = await call();
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32001, message: "tracker: Fake MCP no longer accepts the saved sign-in (invalid_grant: refresh token revoked): sign in again." },
    });
    lease.release();
    expect((await call()).status).toBe(401);
});

// A session with placeholder values, for a check that reads only its access token.
const placeholderSession = () => ({
    mcpOAuth: 1 as const,
    issuer: "https://x.example",
    server: "x.example",
    tokenEndpoint: "https://x.example/token",
    clientId: "c",
    clientAuth: "none" as const,
    redirectUri: "https://sandbox-test.sbx.example/oauth/mcp/callback",
    resource: "https://x.example/mcp",
    accessToken: "at",
});
