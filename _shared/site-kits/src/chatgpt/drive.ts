import { sleep } from "@intentic/base/async";
import { type PageCall, pageCall } from "../host.js";
import type { ChatgptHost } from "./host.js";
import { installActing, installAsking, installReading, installWatching, removeHelpers } from "./page-hands.js";
import { CHATGPT_PAGE, CHATGPT_SITE } from "./site.js";

// How the engine drives ChatGPT's page through its host, shared by the chat (engine.ts) and its project (project.ts).

// The helpers every step reads, in the order they build on each other (page-hands.ts).
const HELPERS: readonly PageCall<boolean>[] = [
    pageCall(installReading, [CHATGPT_PAGE, CHATGPT_SITE.host]),
    pageCall(installActing, []),
    pageCall(installWatching, []),
    pageCall(installAsking, []),
];
const CLEANUP = pageCall(removeHelpers, []);

// One step in the page: the helpers installed first (again, since the document may have been replaced since the last
// step), then the step. Undefined when the page did not answer.
export const step = async <Args extends unknown[], Result>(
    host: ChatgptHost,
    page: number,
    func: (...args: Args) => Promise<Result | null> | Result | null,
    args: Args,
): Promise<Result | undefined> => await host.run(page, { helpers: HELPERS, step: pageCall(func, args), cleanup: CLEANUP });

// Whether an address the host gave can be read at all ("" is one the browser hides).
export const readable = (url: string | undefined): url is string => url !== undefined && url !== "";

// The page's address once `matches` says it is the one wanted, looked at every quarter second until `waitMs`: a page
// that moves itself (ChatGPT's own router after "Create project") raises no load the engine could wait on.
export const untilAddress = async (host: ChatgptHost, page: number, matches: (url: URL) => boolean, waitMs: number): Promise<string | undefined> => {
    const until = Date.now() + waitMs;
    for (;;) {
        const url = await host.address(page);
        if (readable(url) && matches(new URL(url))) {
            return url;
        }
        if (Date.now() >= until) {
            return undefined;
        }
        await sleep(250);
    }
};
