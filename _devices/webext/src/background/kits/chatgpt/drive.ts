import { sleep } from "@intentic/base/async";
import { untilTabLoaded } from "../../tools/tab-loaded.js";
import { injectTolerant } from "../kit.js";
import { installActing, installAsking, installReading, installWatching } from "./page-hands.js";
import { CHATGPT_PAGE, CHATGPT_SITE } from "./site.js";

// How the worker drives ChatGPT's tab, shared by the chat (chat.ts) and its project (project.ts).

// One step in the page: the helpers installed first (again, since the document may have been replaced since the last
// step), then the step. Undefined when the page did not answer.
export const step = async <Args extends unknown[], Result>(tabId: number, func: (...args: Args) => Promise<Result | null> | Result | null, args: Args): Promise<Result | undefined> => {
    await injectTolerant(tabId, installReading, [CHATGPT_PAGE, CHATGPT_SITE.host]);
    await injectTolerant(tabId, installActing, []);
    await injectTolerant(tabId, installWatching, []);
    await injectTolerant(tabId, installAsking, []);
    // SAFETY: a step answers its Result or null, and injectTolerant turns null into undefined.
    return (await injectTolerant(tabId, func, args)) as Result | undefined;
};

// Points the kit's own tab at `url` and waits for it to load.
export const go = async (tabId: number, url: string): Promise<void> => {
    await chrome.tabs.update(tabId, { url });
    await untilTabLoaded(tabId);
};

// The tab's address once `matches` says it is the one wanted, looked at every quarter second until `waitMs`: a page that
// moves itself (ChatGPT's own router after "Create project") raises no load the worker could wait on.
export const untilAddress = async (tabId: number, matches: (url: URL) => boolean, waitMs: number): Promise<string | undefined> => {
    const until = Date.now() + waitMs;
    for (;;) {
        // allow(silent-catch): a tab closed meanwhile is an address never reached, which undefined says
        const url = (await chrome.tabs.get(tabId).catch(() => undefined))?.url;
        if (url !== undefined && matches(new URL(url))) {
            return url;
        }
        if (Date.now() >= until) {
            return undefined;
        }
        await sleep(250);
    }
};
