/* Where fileq stands and where its files go, resolved once per process. Inside a sandbox WORKSPACE_ROOT names
 * the workspace and sidecars live under its state directory (sidecar.ts); outside one (a bare
 * `npx @intentic/fileq`), there is no workspace and no sidecars — `read` still works, saving its full output
 * under an XDG home so a budget cut always has a file to point at. */
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
export const tokensOf = (text: string): number => Math.ceil(text.length / 4);
