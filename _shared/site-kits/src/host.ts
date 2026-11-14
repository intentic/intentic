// What every site kit hands the browser that runs it, whichever browser that is (2026-11-14). A kit's engine decides
// every step and every word an agent reads; its host (a browser extension's worker, the sandbox's daemon driving
// Playwright) does only what its browser does differently. These are the pieces that cross between them.

// A refusal the agent reads as written: nothing went wrong in the code, the call cannot go on, and the message says
// why and what to do instead. Each host turns it into its own refusal, so the words reach the agent unchanged.
export class KitRefusal extends Error {}

// What a call needs of a site: to read it, or to type and press on it too.
export type Need = "read" | "act";

// A file a host saved for the agent, as an answer names it.
export interface SavedFile {
    readonly path: string;
    readonly bytes: number;
    readonly mimeType: string;
}

// One function to run inside the page, with the JSON arguments it is called with. The function is self-contained: a
// host hands the page its source text alone (chrome.scripting.executeScript, Playwright's evaluate), so it may refer to
// nothing outside itself.
export interface PageCall<Result = unknown> {
    readonly func: (...args: never) => Result;
    readonly args: readonly unknown[];
}

// Binds a page function to its arguments, which the compiler checks against it here, once.
export const pageCall = <Args extends unknown[], Result>(func: (...args: Args) => Result, args: Args): PageCall<Result> => ({ func, args });

// One step of a kit in the page. `helpers` install, in order, what the step reads on the page's window, each answering
// false when it could not (the page is not the kit's site); `step` then answers its result, or null when the helpers
// are missing; `cleanup` takes the helpers away. A host that runs in an isolated world may leave them installed.
export interface PageStep<Result> {
    readonly helpers: readonly PageCall<boolean>[];
    readonly step: PageCall<Result | null | Promise<Result | null>>;
    readonly cleanup: PageCall<boolean>;
}
