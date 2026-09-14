/* Where fileq stands and where its files go, resolved once per process. */
import { homedir } from "node:os";
import { join } from "node:path";

export const workspaceRoot = (): string | undefined => {
    const root = process.env["WORKSPACE_ROOT"];
    return root === undefined || root === "" ? undefined : root;
};

export const fileqHome = (): string => {
    const explicit = process.env["FILEQ_HOME"];
    if (explicit !== undefined && explicit !== "") {
        return explicit;
    }
    const xdg = process.env["XDG_CACHE_HOME"];
    return join(xdg !== undefined && xdg !== "" ? xdg : join(homedir(), ".cache"), "fileq");
};

export const defaultOutDir = (): string => join(fileqHome(), "out");

/** The one token estimate everything reports: ~4 chars per token, the usual English-prose rule of thumb. */
// The budget unit, shared with iq and the daemon so a cap and the thing it cut are counted the same way.
export { estimateTokens as tokensOf } from "@intentic/base/format";
