// Where a tool's own files go, resolved the same way for every tool so one answer locates any of them.
import { homedir } from "node:os";
import { join } from "node:path";

/** `<NAME>_HOME` when set, else the XDG cache dir, else `~/.cache` — one directory per tool, never shared. */
export const toolHome = (name: string): string => {
    const explicit = process.env[`${name.toUpperCase()}_HOME`];
    if (explicit !== undefined && explicit !== "") {
        return explicit;
    }
    const xdg = process.env["XDG_CACHE_HOME"];
    return join(xdg !== undefined && xdg !== "" ? xdg : join(homedir(), ".cache"), name);
};

/** Where output files land when `--out` is not given; the same leaf name in every tool, so a reader can guess it. */
export const toolOutDir = (name: string): string => join(toolHome(name), "out");
