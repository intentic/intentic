import type { PrismaClient } from "@intentic-app/prisma";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import type { Logger } from "pino";
import type { Auth } from "../auth.js";
import type { Config } from "../config.js";
import { poolEnabled } from "../pool/pool-membership.js";
import { registerServiceTools } from "./mcp-tools.js";

/* THE MCP DOOR, how a coding agent that is not running in a sandbox reaches the services catalog.
 *
 * Everything the platform sells was, until now, reachable only through a sandbox's connect token, which made
 * owning a machine an accidental precondition for buying and spending a membership. This mount is the other
 * door: a Claude Code session installs the `intentic` plugin, Claude Code discovers the OAuth metadata Better
 * Auth serves (auth.ts `mcp`), the person signs in once in a browser, and the session then carries a bearer
 * that names their account and nothing else.
 *
 * STATELESS, ONE SERVER PER REQUEST. No session id is generated and no transport is kept: each POST builds an
 * McpServer closed over the authenticated user, answers, and is thrown away. That is not a shortcut, it is
 * what lets any replica answer any request, survives a deploy mid-conversation, and removes the whole class of
 * bugs where an approval is stranded on a connection that has since died. The one thing a long-lived session
 * would buy, pushing "the browser step is finished" at the client, is the thing Claude Code's own UX does
 * not need: it asks the user to confirm in the terminal once they are done, and the retry re-reads the row.
 *
 * WHAT IS DELIBERATELY NOT HERE: the wallet. x402 payments need custody, a policy engine and the
 * quarantined-turn rule that strips a poisoned turn's auto-approve band, machinery that belongs to a sandbox
 * and does not travel. The metered, refunded, catalogued rail is the one that survives leaving home. */

export interface McpDeps {
    readonly config: Config;
    readonly prisma: PrismaClient;
    readonly auth: Auth;
    // Injectable so tests drive the service forward without a network, the pool's pattern.
    readonly fetchFn?: typeof fetch;
    readonly now?: () => Date;
    /* The demo service's upstream is the platform itself, so its forward dispatches in-process. Passed in
     * because only the caller (app.ts) holds the Hono app to dispatch into. */
    readonly demoDispatch?: typeof fetch;
}

const SERVER_INFO = { name: `intentic`, version: `1.0.0` } as const;

const INSTRUCTIONS =
    `intentic's premium services: metered capabilities (research, data, heavy compute) priced in the owner's ` +
    `membership credits. Call services_list first — it names what exists, what a run costs, and what is left today. ` +
    `services_run asks for ONE run: the owner approves it on a page this platform renders, and only their click ` +
    `there releases the spend, so prefer free tools when they answer just as well and never loop runs. A service ` +
    `that fails to answer is refunded automatically. If nothing in the catalog answers a need a paid service ` +
    `plausibly could, file one line with services_wanted and carry on.`;

export const mcpHttpRoutes = ({ config, prisma, auth, fetchFn = fetch, now = () => new Date(), demoDispatch }: McpDeps) => {
    const app = new Hono<{ Variables: { logger: Logger } }>();

    /* 401 WITH A POINTER, not 404, the one place on this platform where saying what is wrong is the correct
     * move. An MCP client discovers where to authenticate by reading `WWW-Authenticate` off exactly this
     * refusal; answering blankly would leave Claude Code with a dead server and no way to offer a sign-in. */
    const unauthorized = (c: { json: (body: unknown, status: 401, headers: Record<string, string>) => Response }) => {
        const wwwAuthenticate = `Bearer resource_metadata="${config.api.url}/api/auth/.well-known/oauth-protected-resource"`;
        return c.json(
            { jsonrpc: `2.0`, id: null, error: { code: -32000, message: `Unauthorized: sign in to intentic to use premium services` } },
            401,
            { "WWW-Authenticate": wwwAuthenticate, "Access-Control-Expose-Headers": `WWW-Authenticate` },
        );
    };

    app.all(`/`, async (c) => {
        // A platform that sells nothing has no services door, the pool's own posture verbatim.
        if (!poolEnabled(config)) {
            return c.json({ error: `premium services are not enabled on this platform` }, 404);
        }
        const session = await auth.api.getMcpSession({ headers: c.req.raw.headers }).catch(() => null);
        if (session?.userId === undefined || session.userId === null) {
            return unauthorized(c);
        }
        const ownerId = session.userId;
        const logger = c.get(`logger`);
        const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
        registerServiceTools(
            server,
            {
                config,
                prisma,
                fetchFn,
                now,
                demoDispatch,
                warn: (message, service) => logger?.warn({ service }, message),
            },
            ownerId,
        );
        /* Stateless: `sessionIdGenerator` left undefined, so no session id is minted, nothing is remembered
         * between requests, and any replica may answer any of them. The transport closes itself when the
         * response's stream ends or the client goes away; closing it here would cut the SSE stream this call's
         * own answer rides on. */
        const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: false });
        // The SDK's Transport is a plain object with an `onclose` property, not an EventTarget, nothing to add.
        // eslint-disable-next-line unicorn/prefer-add-event-listener
        transport.onclose = () => void server.close().catch(() => undefined);
        await server.connect(transport);
        return await transport.handleRequest(c.req.raw);
    });

    return app;
};
