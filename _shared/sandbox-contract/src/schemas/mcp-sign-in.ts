import { z } from "zod";

// Signing in to a remote MCP server that authenticates with OAuth (the MCP authorization spec: protected-resource
// metadata, authorization-server discovery, client registration, then an authorization code with PKCE). The sandbox
// runs every leg but the person's approval: the browser opens the authorization server's page and lands back on the
// sandbox's own callback, and the tokens never reach the browser. What the form gets back is a stash marker
// (`stashedMarker`, schemas/capabilities.ts) for the connection's `token`, the same way a generated SSH key arrives.

// POST /capabilities/mcp-auth: what an MCP URL asks of a client, read before anything is saved.
export const McpAuthCheckInputSchema = z.object({
    url: z.url().describe("The MCP server's address, as the form holds it."),
});
export const McpAuthCheckSchema = z.object({
    auth: z
        .enum(["open", "token", "oauth", "unreachable"])
        .describe(
            "`open`: it answered without a credential. `token`: it refused one and names no sign-in, so it takes a token pasted from its own settings. `oauth`: it names an authorization server to sign in with. `unreachable`: it did not answer as an MCP server.",
        ),
    server: z.string().optional().describe("What to call the place you sign in at: the server's own name for itself, or the authorization server's host."),
    registers: z
        .boolean()
        .optional()
        .describe("Whether the authorization server registers this sandbox as a client by itself. False: a client ID made in its own settings is needed."),
    redirectUri: z
        .string()
        .optional()
        .describe("Where the authorization server sends the browser back: the redirect address a client made by hand must allow."),
    detail: z.string().optional().describe("What went wrong, for `unreachable`, in words a person can act on."),
});
export type McpAuthCheck = z.infer<typeof McpAuthCheckSchema>;

// POST /capabilities/mcp-sign-in: starts a sign-in; the browser opens `authorizeUrl` and waits on `flow`.
export const McpSignInInputSchema = z.object({
    url: z.url().describe("The MCP server's address."),
    clientId: z
        .string()
        .trim()
        .min(1)
        .max(512)
        .optional()
        .describe("A client ID made in the authorization server's own settings, for a server that registers no client by itself."),
    keeping: z
        .string()
        .optional()
        .describe("The connection being edited, whose registered client is reused when it signed in at the same authorization server."),
});
export const McpSignInStartSchema = z.object({
    flow: z.string().describe("Stands for this sign-in, to wait on. Lapses after ten minutes."),
    authorizeUrl: z.url().describe("The authorization server's page, for the person to approve in their browser."),
    redirectUri: z.string().describe("Where the authorization server sends the browser back: this sandbox's own callback."),
    server: z.string().describe("What to call the authorization server."),
});
export type McpSignInStart = z.infer<typeof McpSignInStartSchema>;

// POST /capabilities/mcp-sign-in/wait: answers as soon as the sign-in ends, or `waiting` after a while.
export const McpSignInWaitInputSchema = z.object({ flow: z.string().min(1).describe("The sign-in, as its start answered.") });
export const McpSignInWaitSchema = z.discriminatedUnion("state", [
    z.object({ state: z.literal("waiting").describe("Nobody has come back from the authorization server yet. Ask again.") }),
    z.object({
        state: z.literal("done"),
        token: z
            .string()
            .describe(
                "Stands for the signed-in session, which never leaves the sandbox. Sent wrapped as a stash marker in the connection's `token`, it installs that session once, and it lapses after thirty minutes.",
            ),
        server: z.string().describe("Where the sign-in happened."),
        account: z.string().optional().describe("Who signed in, when the authorization server said."),
        scope: z.string().optional().describe("The access granted, as the authorization server's own scope words."),
    }),
    z.object({ state: z.literal("failed"), message: z.string().describe("Why it did not finish, in words a person can act on.") }),
]);
export type McpSignInWait = z.infer<typeof McpSignInWaitSchema>;
