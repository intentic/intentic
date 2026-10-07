import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { readMcpAppData } from "@intentic/sandbox-contract";
import { stateRelPath } from "../../state-paths.js";
import { SHOW_PAGE_TOOL } from "./page-names.js";

// What a page's own scripts threw in a reader's chat, said to the agent that showed it: the chat's frame catches each
// uncaught error over the bridge (sandbox-contract text/pages.ts) and the editor hands them here. The check the agent
// can ask for sees one browser at one width before the page is shown; this is the reader's own browser, after. Said
// only into the turn that showed the page, while it runs, so the agent fixes its own page before it ends: a later turn
// is about something else, and waking an idle conversation would spend a turn nobody asked for. The reader is offered
// the ask on the page's own line instead.

const PAGES_DIR = `${stateRelPath(".intentic/records/artifacts/", "pages")}/`;
const DRAWING = /^([A-Za-z0-9_-]+)\/([a-f0-9]{10})\.r(\d+)\.html$/;

// Drawings already told, so a page open in two windows, or mounted again, is said once. Bounded: oldest let go first.
const TOLD_KEPT = 256;
const told = new Set<string>();

export interface PageErrorsDeps {
    readonly workspaceRoot: string;
    // When the conversation's running turn started, or undefined when it has none.
    readonly runningSince: (conversationId: string) => number | undefined;
    // The words into that turn, in the sandbox's voice; true when the turn took them.
    readonly steer: (conversationId: string, text: string) => Promise<boolean>;
}

// The notice as the agent reads it: which page, what it threw, and the call that redraws it. The errors are the page's
// own text, quoted as such.
export const pageErrorsNotice = (pageId: string, revision: number, errors: readonly string[]): string =>
    [
        `The page "${pageId}" you showed${revision === 0 ? "" : ` (redraw ${revision})`} threw in the reader's chat as it drew. Its uncaught errors, as its own scripts reported them:`,
        errors.map((error) => `- ${error.replace(/\s+/g, " ")}`).join("\n"),
        `The reader may be looking at a broken page. Fix its script and draw it again with \`mcp__ui__${SHOW_PAGE_TOOL}\` and replaces: "${pageId}".`,
    ].join("\n\n");

// Tells the turn that showed the page what it threw; false when nobody was told (see the module comment for when).
export const reportPageErrors = async (deps: PageErrorsDeps, input: { readonly page: string; readonly errors: readonly string[] }): Promise<boolean> => {
    const drawing = input.page.startsWith(PAGES_DIR) ? DRAWING.exec(input.page.slice(PAGES_DIR.length)) : null;
    if (drawing === null || told.has(input.page)) {
        return false;
    }
    const [, conversationId, pageId, revision] = drawing as unknown as [string, string, string, string];
    const since = deps.runningSince(conversationId);
    if (since === undefined) {
        return false;
    }
    const file = join(deps.workspaceRoot, input.page);
    // Drawn by this turn: a page from an earlier one is not what the running turn is doing.
    const info = await stat(file).catch(undefinedIfMissing);
    if (info === undefined || info.mtimeMs < since) {
        return false;
    }
    // An MCP server's app is that server's code, not the agent's to fix, and its text is not the agent's to be handed.
    const html = await readFile(file, "utf8").catch(undefinedIfMissing);
    if (html === undefined || readMcpAppData(html) !== undefined || told.has(input.page)) {
        return false;
    }
    // Taken before the words go, so a second window reporting the same drawing meanwhile finds it told.
    told.add(input.page);
    if (!(await deps.steer(conversationId, pageErrorsNotice(pageId, Number(revision), input.errors)))) {
        told.delete(input.page);
        return false;
    }
    for (const stale of told) {
        if (told.size <= TOLD_KEPT) {
            break;
        }
        told.delete(stale);
    }
    return true;
};
