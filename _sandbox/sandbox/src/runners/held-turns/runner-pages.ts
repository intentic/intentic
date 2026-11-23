import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { Logger } from "pino";
import { keepPageCopy } from "../../workspace/files/stored-pages.js";
import type { RunnerHub } from "../runner-peer.js";

/* THE PAGES A RUNNER'S TURN SHOWED, BROUGHT HOME. `show_page` files the page in the workspace of the machine running the
   turn (page-store.ts), and its frame names that path; the chat reads every page from this sandbox's workspace, and
   neither the relay nor the branch's push carries a records file. So a runner's page read as "could not be loaded"
   (bird-mdu4 on omen, 2026-11-23). Each page frame now waits while its file is fetched from the runner and filed here at
   the same path, so the frame reaches the chat with the page already in place. */

const ASK_MS = 30_000;

export interface PagesHomeContext {
    readonly hub: Pick<RunnerHub, "client">;
    readonly logger: Pick<Logger, "warn">;
    readonly runnerId: string;
    readonly workspaceRoot: string;
}

// The stored page a frame draws, when it draws one.
const pageOf = (event: AgentEvent): string | undefined => (event.kind === "page" || event.kind === "page_ask" ? event.page.path : undefined);

/** Files the page a frame draws before the frame goes on; a page that cannot be fetched is logged and the frame still goes. */
export const bringPageHome = async (context: PagesHomeContext, event: AgentEvent): Promise<void> => {
    const path = pageOf(event);
    const client = path === undefined ? undefined : context.hub.client(context.runnerId);
    if (path === undefined || client === undefined) {
        return;
    }
    try {
        const { html } = await client.readPage({ path }, { signal: AbortSignal.timeout(ASK_MS) });
        if (!(await keepPageCopy(context.workspaceRoot, path, html))) {
            context.logger.warn({ runner: context.runnerId, path }, "runner dispatch: a page frame named no stored page, so nothing was filed");
        }
    } catch (error) {
        context.logger.warn({ err: error, runner: context.runnerId, path }, "runner dispatch: a page the runner showed could not be brought home");
    }
};
