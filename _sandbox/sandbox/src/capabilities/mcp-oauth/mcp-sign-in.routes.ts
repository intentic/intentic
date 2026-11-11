import type { Context } from "hono";
import type { AppEnv } from "../../app-env.js";
import type { Services } from "../../composition.js";
import { defineRawRoutes } from "../../http/raw-route-server.js";
import type { Landing, McpSignIns } from "./mcp-sign-ins.js";

// Where an MCP server's authorization server sends the browser back after the person approves (or declines), on this
// sandbox's own public address. A door route: no session reaches it, since the browser arrives from the authorization
// server with nothing but the answer in its address. The answer is acted on only for a sign-in this daemon started
// (mcp-sign-ins.ts); the form that started it learns the outcome by waiting on it, so this page only says so and closes.

const escapeHtml = (text: string): string =>
    text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);

// A page of its own rather than the app: the browser is on the sandbox's address, not the editor's, and has nothing to
// sign the app in with. It drops the code from the address bar and history, then closes the window it opened in.
const landingPage = (landing: Landing): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${landing.ok ? "Signed in" : "Sign-in did not finish"}</title>
<style>
:root { color-scheme: light dark; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
p { max-width: 24rem; padding: 0 1.5rem; text-align: center; line-height: 1.5; }
</style>
</head>
<body>
<p>${escapeHtml(landing.message)}</p>
<script>
history.replaceState(null, "", location.pathname);
${landing.ok ? "setTimeout(() => window.close(), 600);" : ""}
</script>
</body>
</html>
`;

export const createMcpCallbackRoute =
    (signIns: Pick<McpSignIns, "land">) =>
    async (c: Context<AppEnv>): Promise<Response> => {
        const landing = await signIns.land(new URL(c.req.url).searchParams);
        // Never cached, and never handed on as a referrer: the address carried a one-time code.
        c.header("cache-control", "no-store");
        c.header("referrer-policy", "no-referrer");
        return c.html(landingPage(landing), landing.ok ? 200 : 400);
    };

export const mcpSignInRawRoutes = defineRawRoutes((services: Pick<Services, "mcpSignIns">) => ({
    "GET /oauth/mcp/callback": createMcpCallbackRoute(services.mcpSignIns),
}));
