/* Where webq keeps things, resolved once per process. Everything lives under one home directory so a human
 * (or a chore) can delete a single tree: cache/ holds fetched HTML keyed by URL, out/ holds the markdown
 * the commands write. WEBQ_HOME moves the whole tree (the sandbox image points it at workspace-visible
 * storage); the default follows XDG so a bare `npx @intentic/webq` behaves like any other CLI. */
import { homedir } from "node:os";
import { join } from "node:path";

export const webqHome = (): string => {
    const explicit = process.env["WEBQ_HOME"];
    if (explicit !== undefined && explicit !== "") {
        return explicit;
    }
    const xdg = process.env["XDG_CACHE_HOME"];
    return join(xdg !== undefined && xdg !== "" ? xdg : join(homedir(), ".cache"), "webq");
};

export const cacheDir = (): string => join(webqHome(), "cache");
export const defaultOutDir = (): string => join(webqHome(), "out");

/** The one token estimate everything reports: ~4 chars per token, the usual English-prose rule of thumb. */
// The budget unit, shared with iq and the daemon so a cap and the thing it cut are counted the same way.
export { estimateTokens as tokensOf } from "@intentic/base/format";
