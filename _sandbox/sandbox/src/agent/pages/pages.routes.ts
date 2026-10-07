import { readFile } from "node:fs/promises";
import { pagesContract, readMcpAppData } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../../app-env.js";
import { mcpToolsOf } from "../../capabilities/mcp-tools.js";
import type { Services } from "../../composition.js";
import { resolveWithin } from "../../workspace/files/workspace-files-paths.js";
import { stateRelPath } from "../../state-paths.js";
import { callForApp } from "./mcp-apps.js";

// The /pages routes: what an MCP server's app, drawn in a chat, asks of its own server while a reader uses it. The page
// names its server and tool (stored inside it when it was shown, mcp-apps.ts); the request names only the page and the
// tool, so an app can reach no server but the one it was shown for, and there only a tool its server lets it call.

export type PagesRoutesDeps = Pick<Services, "capabilities" | "workspace">;

const PAGES_DIR = `${stateRelPath(".intentic/records/artifacts/", "pages")}/`;

export const createPagesRoutes = (services: PagesRoutesDeps) => {
    const i = implement(pagesContract).$context<OrpcContext>();
    return {
        appCall: i.appCall.handler(async ({ input }) => {
            const file = input.page.startsWith(PAGES_DIR) ? resolveWithin(services.workspace.root, input.page) : undefined;
            if (file === undefined) {
                throw new ORPCError("BAD_REQUEST", { message: `"${input.page}" is not a page a chat showed` });
            }
            const html = await readFile(file, "utf8").catch(() => undefined);
            const app = html === undefined ? undefined : readMcpAppData(html);
            if (app === undefined) {
                throw new ORPCError("NOT_FOUND", { message: `"${input.page}" is not an MCP server's app` });
            }
            const server = mcpToolsOf(await services.capabilities.list()).find((candidate) => candidate.name === app.server);
            if (server === undefined) {
                throw new ORPCError("NOT_FOUND", { message: `${app.server} is no longer connected` });
            }
            const answer = await callForApp(server, { name: input.name, arguments: input.arguments, pressed: input.pressed === true }).catch((error: unknown) => ({
                refused: error instanceof Error ? error.message : String(error),
            }));
            if ("refused" in answer) {
                throw new ORPCError("FORBIDDEN", { message: answer.refused });
            }
            return { result: answer.result };
        }),
    };
};
