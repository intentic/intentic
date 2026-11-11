import type { CapabilityStatus, McpConfig } from "@intentic/sandbox-contract/schemas/capabilities";
import { opt } from "../../opt.js";
import type { CapabilityCtx, CapabilityHandler } from "../capability.js";
import { mcpBearerOf, mcpSessionOf } from "../mcp-oauth/mcp-session.js";

// A single-shot reachability probe: the agent reaches the MCP over HTTP, so "up" ≈ it answers at all within 2s (a bare
// GET may 404 or 405, which still proves it's up). The status is kept, since a 401 says the credential is the problem.
// Never throws: a probe failure is just undefined.
const reach = async (url: string, bearer: string | undefined): Promise<number | undefined> => {
    try {
        const response = await fetch(url, {
            signal: AbortSignal.timeout(2000),
            ...(bearer !== undefined ? { headers: { Authorization: `Bearer ${bearer}` } } : {}),
        });
        // A server that opens its event stream on GET would hold this connection open; the status is all that is read.
        await response.body?.cancel();
        return response.status;
    } catch {
        return undefined;
    }
};

const UNREACHABLE: CapabilityStatus = { state: "error", detail: "unreachable" };

// A signed-in connection: its bearer renewed when due, and a refusal of it renewed once more before it is called a lapsed
// sign-in. `pending` is how the card says "needs sign-in" (connections.ts), apart from `error`, which is unreachable.
const signedInStatus = async (ctx: CapabilityCtx, id: string, url: string, server: string): Promise<CapabilityStatus> => {
    const held = await ctx.mcpSignIns.bearer(id);
    if ("signIn" in held) {
        return { state: "pending", detail: held.signIn };
    }
    const status = await reach(url, held.bearer);
    if (status === undefined || status >= 500) {
        return UNREACHABLE;
    }
    if (status !== 401) {
        return { state: "active" };
    }
    const renewed = await ctx.mcpSignIns.bearer(id, { force: true });
    if ("signIn" in renewed) {
        return { state: "pending", detail: renewed.signIn };
    }
    return (await reach(url, renewed.bearer)) === 401 ? { state: "pending", detail: `${server} refused the saved sign-in: sign in again.` } : { state: "active" };
};

// MCP server: an agent tool. Registration IS the manifest entry, the route upserts it and the agent merge reads
// mcp-kind capabilities, so apply just confirms and status probes the endpoint. remove is a no-op: dropping the
// manifest entry (in the route) is what removes it from the agent. `token` is a pasted bearer or a sign-in's session
// (mcp-oauth/mcp-session.ts); either way the one credential, and never echoed.
export const mcpHandler: CapabilityHandler = {
    secret: (config) => ((config as McpConfig).token !== undefined ? "token" : undefined),
    // A sign-in says where and as whom, and what it was granted, none of which is the credential itself.
    echo: (config) => {
        const { url, token } = config as McpConfig;
        const session = mcpSessionOf(token);
        if (session === undefined) {
            return { url, hasToken: token !== undefined };
        }
        return { url, hasToken: true, signedIn: true, signInServer: session.server, ...opt("account", session.account), ...opt("scope", session.scope) };
    },
    // Registration IS the manifest entry, so moving the entry is the entire rename. What changes for the agent
    // is the server's name and therefore its tool prefix, which is exactly what the owner asked for.
    rename: {},
    async *apply(ctx, _id, config) {
        const { url, token } = config as McpConfig;
        // Saved with no credential: a server that asks for a sign-in would refuse every call, so the form is told now.
        if (mcpBearerOf(token) === undefined) {
            const needs = await ctx.mcpSignIns.check(url);
            if (needs.auth === "oauth") {
                throw new Error(`${needs.server ?? "This server"} asks you to sign in first: press Sign in on the form, then save.`);
            }
        }
        yield { kind: "log", message: `Registered MCP server ${url}, the agent can call it next turn.` };
    },
    status: async (ctx, id, config) => {
        const { url, token } = config as McpConfig;
        const session = mcpSessionOf(token);
        if (session !== undefined) {
            return signedInStatus(ctx, id, url, session.server);
        }
        const bearer = mcpBearerOf(token);
        const status = await reach(url, bearer);
        if (status === undefined || status >= 500) {
            return UNREACHABLE;
        }
        // Nothing to send and refused: a sign-in it names is the missing step, as is a token for one that names none.
        if (status === 401 && bearer === undefined) {
            const needs = await ctx.mcpSignIns.check(url);
            return needs.auth === "oauth"
                ? { state: "pending", detail: `${needs.server ?? "This server"} asks you to sign in: open this connection and press Sign in.` }
                : { state: "error", detail: "it refuses requests without a token: open this connection and add one" };
        }
        return { state: "active" };
    },
    remove: async () => {},
};
