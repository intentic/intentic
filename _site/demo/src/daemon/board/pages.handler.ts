import { STATE_DIR } from "@intentic/constants";
import { readMcpAppData } from "@intentic/sandbox-contract/text/pages";
import { refuse } from "@intentic/contract-serve";
import { PAGE_FILES } from "../../fixture/pages";
import { roster } from "./roster";
import type { Doors } from "../doors";

// Pages the agent showed in a chat, as the daemon's /pages routes answer them. A page lives at
// `pages/<conversation>/<page>.html`, which is how a reported error finds the turn that showed it.
const PAGES_DIR = `${STATE_DIR}/records/artifacts/pages/`;

// Each drawing is told once, as the daemon tells it: a second report of the same page is already heard.
const told = new Set<string>();

const conversationOf = (page: string): string | undefined => (page.startsWith(PAGES_DIR) ? page.slice(PAGES_DIR.length).split(`/`)[0] : undefined);

export const pagesDoors = {
    // Only an MCP server's app calls its server, and no page in this recording is one: the daemon's own refusal for
    // that, in its words, since the page names no server to call. Answered as the fixture's refusal (403) rather than
    // the daemon's 404, so the smoke run tells it apart from a route nobody serves; the app reads the same sentence.
    appCall: ({ page }) => {
        const html = page.startsWith(PAGES_DIR) ? PAGE_FILES.get(page) : undefined;
        if (html === undefined) {
            return refuse(`"${page}" is not a page a chat showed`);
        }
        const app = readMcpAppData(html);
        return refuse(app === undefined ? `"${page}" is not an MCP server's app` : `${app.server} is no longer connected`);
    },
    // Heard when the turn that showed the page is still running and has not been told about this drawing yet.
    reportErrors: ({ page }) => {
        const conversation = conversationOf(page);
        const running = roster.agents.some((agent) => agent.id === conversation && agent.status === `running`);
        if (!running || told.has(page)) {
            return { told: false };
        }
        told.add(page);
        return { told: true };
    },
} satisfies Doors<`pages`>;
