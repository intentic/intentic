import type { SandboxHandlerOutput } from "@intentic/sandbox-contract/protocol/procedure-types";
import { refuse } from "@intentic/contract-serve";
import { BROWSER_SESSIONS } from "../../browser";
import { listeners } from "../board/roster";

// The recorded agent browsers (browser.ts) as this page load's closes left them: a closed session leaves the list, a
// closed tab leaves its session, and the tab beside it becomes the active one, as the daemon's browser pool answers.

type Session = ReturnType<typeof BROWSER_SESSIONS>[number];

const closedSessions = new Set<string>();
const closedPages = new Set<string>();

const withoutClosedPages = (session: Session): Session => {
    const pages = session.pages.filter((page) => !closedPages.has(page.id));
    const active = pages.some((page) => page.active) ? pages : pages.map((page, index) => ({ ...page, active: index === pages.length - 1 }));
    return { ...session, pages: active };
};

export const recordedBrowsers = (now: number): Session[] =>
    BROWSER_SESSIONS(now)
        .filter((session) => !closedSessions.has(session.name))
        .map(withoutClosedPages)
        .filter((session) => session.pages.length > 0);

const pushBrowsers = (): void => {
    for (const listener of listeners) {
        listener({ kind: `runtimeChanged`, domains: [`browsers`] });
    }
};

const recorded = (name: string): Session =>
    recordedBrowsers(Date.now()).find((session) => session.name === name) ?? refuse(`No browser session is called ${name}.`, 404);

export const closeRecordedBrowser = (name: string): SandboxHandlerOutput<`system`, `closeBrowser`> => {
    recorded(name);
    closedSessions.add(name);
    pushBrowsers();
    return { ok: true };
};

export const closeRecordedPage = (name: string, pageId: string): SandboxHandlerOutput<`system`, `closeBrowserPage`> => {
    const session = recorded(name);
    if (!session.pages.some((page) => page.id === pageId)) {
        return refuse(`That tab is not open in ${name} any more.`, 404);
    }
    closedPages.add(pageId);
    pushBrowsers();
    return { ok: true };
};
