import { errorMessage } from "@intentic/base/errors";
import { pagesContract } from "@intentic/sandbox-contract/contracts/pages.contract";
import { readMcpAppData } from "@intentic/sandbox-contract/text/pages";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../../app-env.js";
import { mcpToolsOf } from "../../capabilities/mcp-tools.js";
import type { Services } from "../../composition.js";
import { noteAudit } from "../../audit/audit-http.js";
import { refuseFenced } from "../../workspace/layout/workspace-fence.js";
import { workspaceReads } from "../../workspace/workspace-reads.js";
import { liveRunOf } from "../../conversations/actor/conversation-holdings.js";
import { callForApp } from "./mcp-apps.js";
import { reportPageErrors } from "./page-errors.js";
import { pageMediaKeyPath, verifiedPageMedia } from "./page-media.js";
import { pageMediaBinding } from "./page-media.routes.js";
import { PAGES_DIR } from "./pages-dir.js";
import { readStoredPage } from "./page-store.js";

// The /pages routes: what an MCP server's app, drawn in a chat, asks of its own server while a reader uses it. The page
// names its server and tool (stored inside it when it was shown, mcp-apps.ts); the request names only the page and the
// tool, so an app can reach no server but the one it was shown for, and there only a tool its server lets it call. What
// a page threw as it drew, handed to the turn that showed it (page-errors.ts). And the ticket a page's video and audio
// stream with (page-media.routes.ts).

export type PagesRoutesDeps = Pick<Services, "capabilities" | "workspace" | "conversations" | "turns" | "areas" | "agents" | "workspaceScope" | "mediaTickets" | "config">;

// The conversation a stored page was shown in, from its path (pages/<conversation>/<page>.html, page-store.ts).
const conversationOfPage = (page: string): string | undefined => (page.startsWith(PAGES_DIR) ? page.slice(PAGES_DIR.length).split("/")[0] : undefined);

export const createPagesRoutes = (services: PagesRoutesDeps) => {
    const i = implement(pagesContract).$context<OrpcContext>();
    const reads = workspaceReads(services);
    return {
        appCall: i.appCall.handler(async ({ input }) => {
            const html = await readStoredPage(services.workspace.root, input.page);
            if (html === undefined) {
                throw new ORPCError("BAD_REQUEST", { message: `"${input.page}" is not a page a chat showed` });
            }
            const app = readMcpAppData(html);
            if (app === undefined) {
                throw new ORPCError("NOT_FOUND", { message: `"${input.page}" is not an MCP server's app` });
            }
            const server = mcpToolsOf(await services.capabilities.list()).find((candidate) => candidate.name === app.server);
            if (server === undefined) {
                throw new ORPCError("NOT_FOUND", { message: `${app.server} is no longer connected` });
            }
            const answer = await callForApp(server, { name: input.name, arguments: input.arguments, pressed: input.pressed === true }).catch(
                (error: unknown) => ({
                    refused: errorMessage(error),
                }),
            );
            if ("refused" in answer) {
                throw new ORPCError("FORBIDDEN", { message: answer.refused });
            }
            return { result: answer.result };
        }),
        // Asked like a read of the page itself (a fenced reader is held to their folders as /workspace/raw holds them),
        // bound to the page rather than to any file, so it buys only what the page named when it was shown, and named
        // after its minter, so signing them out ends it (auth/tokens/media-tickets.ts).
        // A caller who may not see the conversation that showed the page may not play what it showed either, as they may
        // not read out of its checkout (workspace-reads.ts). Only a page whose manifest the daemon signed for it is minted
        // for. Audited as a read of the page, like GET /workspace/raw; the streaming route behind it never is.
        mediaTicket: i.mediaTicket.handler(async ({ input, context }) => {
            noteAudit({ target: input.page });
            reads.refuseUnseenAgent(context, conversationOfPage(input.page));
            refuseFenced(await reads.fenceFor(context), input.page);
            const html = await readStoredPage(services.workspace.root, input.page);
            const media = html === undefined ? undefined : await verifiedPageMedia(pageMediaKeyPath(services.config.historyRoot), input.page, html);
            if (media === undefined) {
                throw new ORPCError("NOT_FOUND", { message: `"${input.page}" is not a shown page that plays video or audio` });
            }
            return services.mediaTickets.mint(pageMediaBinding(input.page), undefined, context.identity?.email);
        }),
        reportErrors: i.reportErrors.handler(async ({ input }) => ({
            told: await reportPageErrors(
                {
                    workspaceRoot: services.workspace.root,
                    runningSince: (conversationId) => liveRunOf(services.conversations, conversationId)?.startedAt,
                    steer: async (conversationId, text) => (await services.turns.steer(conversationId, { text, voice: "sandbox" })) === true,
                },
                input,
            ),
        })),
    };
};
