import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { errnoCode, undefinedIfMissing } from "@intentic/base/errors";
import { stateRelPath } from "../../../state-paths.js";
import { resolveRealWithin } from "../workspace-files-paths.js";

// The files of the pages chats showed (the agent's show_page, agent/pages/page-store.ts files them), as anything that
// reads one by the path its transcript names sees them: kept here, below the agent, so a runner's relay can file a page
// its turn showed (runners/held-turns/runner-pages.ts) and a runner can serve one, without reaching up into the agent.

// Where every page a chat showed is stored, workspace-relative with its trailing slash: what the page routes take a
// page's path to start with, and the root they resolve it inside.
export const PAGES_DIR = `${stateRelPath(".intentic/records/artifacts/", "pages")}/`;

// One drawing's path below PAGES_DIR: the conversation's folder, the page's id and its drawing number.
export const PAGE_DRAWING = /^([A-Za-z0-9_-]+)\/([a-f0-9]{10})\.r(\d+)\.html$/;

// A stored page's text, by the workspace path a transcript names it with; undefined for a path that is not a stored page.
// Resolved inside the pages folder itself, never the workspace: a page path that climbs out of it (`../`) or through a
// link names a file no chat showed, whatever it holds.
export const readStoredPage = async (workspaceRoot: string, page: string): Promise<string | undefined> => {
    const file = page.startsWith(PAGES_DIR) ? (await resolveRealWithin(join(workspaceRoot, PAGES_DIR), page.slice(PAGES_DIR.length)))?.real : undefined;
    return file === undefined ? undefined : readFile(file, "utf8").catch(undefinedIfMissing);
};

// Files here a page another machine showed (a runner's turn, runners/held-turns/runner-pages.ts), at the path its transcript names,
// so the chat reads it from this workspace as it does a page shown here. False for a path that is not one drawing in a
// conversation's folder. A drawing already here is left as it is: a stored page is never rewritten.
export const keepPageCopy = async (workspaceRoot: string, page: string, html: string): Promise<boolean> => {
    const drawing = page.startsWith(PAGES_DIR) ? PAGE_DRAWING.exec(page.slice(PAGES_DIR.length)) : null;
    if (drawing === null) {
        return false;
    }
    await mkdir(join(workspaceRoot, PAGES_DIR, drawing[1] ?? ""), { recursive: true });
    try {
        await writeFile(join(workspaceRoot, page), html, { encoding: "utf8", flag: "wx" });
    } catch (error) {
        if (errnoCode(error) !== "EEXIST") {
            throw error;
        }
    }
    return true;
};
