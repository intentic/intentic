import { parseJsonWith } from "@intentic/base/json";
import { z } from "zod";

// What an mcp connection's `token` holds once someone signed in through the sandbox (mcp-sign-ins.ts) instead of
// pasting a bearer: the current access token, with everything needed to keep it fresh. It rides the one credential
// field the card already has, so vaulting it, keeping it across an edit, stashing it for the form and replacing it from
// the secrets page all work as they do for a pasted token. A pasted bearer is never a JSON object, which is how the two
// are told apart; `mcpOAuth` is the marker and the shape's version, read by whatever changes this shape later.
export const McpSessionSchema = z.object({
    mcpOAuth: z.literal(1),
    // The authorization server, by its validated metadata's `issuer`: the client below belongs to it alone.
    issuer: z.string(),
    // What to call it on the form and the card: the MCP server's own name for itself, or the issuer's host.
    server: z.string(),
    tokenEndpoint: z.string(),
    clientId: z.string(),
    clientSecret: z.string().optional(),
    // How the token endpoint is told who the client is (RFC 7591 `token_endpoint_auth_method`).
    clientAuth: z.enum(["none", "client_secret_post", "client_secret_basic"]),
    // The callback the client was registered with, sent again with every code it trades.
    redirectUri: z.string(),
    // The MCP server the tokens are for (RFC 8707), sent with every token request.
    resource: z.string(),
    accessToken: z.string(),
    refreshToken: z.string().optional(),
    // Epoch milliseconds; absent when the authorization server gave no lifetime.
    expiresAt: z.number().optional(),
    scope: z.string().optional(),
    // Who signed in, when the authorization server said (an OpenID id_token's email or name).
    account: z.string().optional(),
});
export type McpSession = z.infer<typeof McpSessionSchema>;

export const mcpSessionOf = (token: string | undefined): McpSession | undefined => {
    const text = token?.trim() ?? "";
    return text.startsWith("{") ? parseJsonWith(text, McpSessionSchema) : undefined;
};

export const encodeMcpSession = (session: McpSession): string => JSON.stringify(session);

// The bearer an mcp connection's `token` sends: a sign-in's current access token, or the pasted token itself. Trimmed:
// a token saved before pastes were trimmed still carries its newline.
export const mcpBearerOf = (token: string | undefined): string | undefined => {
    const session = mcpSessionOf(token);
    if (session !== undefined) {
        return session.accessToken;
    }
    const pasted = token?.trim() ?? "";
    return pasted === "" ? undefined : pasted;
};
