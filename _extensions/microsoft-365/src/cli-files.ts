import { readFile } from "node:fs/promises";
import type { Arguments } from "./commands.js";
import { fetchDownload, saveBytes, workspaceFile } from "./files.js";
import type { Http } from "./auth.js";
import type { Json } from "./graph.js";
import type { RunAnswer } from "./tools.js";

// The CLI's half of a command: the workspace files it reads, sent to the backend as bytes, and the files that come
// back, saved. The backend never touches the workspace, so a command's paths mean what they meant: workspace-relative,
// inside it, symlinks included, and nothing saved over a file already there.

// The files a command reads: its `--file`, and each of its `--attach` list, by the path as the agent wrote it.
export const inputsOf = async (root: string, args: Arguments): Promise<Record<string, string>> => {
    const named = [
        ...(args.flags["file"] === undefined ? [] : [args.flags["file"]]),
        ...(args.flags["attach"] ?? "")
            .split(",")
            .map((path) => path.trim())
            .filter((path) => path !== ""),
    ];
    const files: Record<string, string> = {};
    for (const path of named) {
        files[path] = (await readFile(await workspaceFile(root, path, false))).toString("base64");
    }
    return files;
};

// Every string in the output that names a path the backend handed back, replaced by where it was saved.
const withSavedPaths = (value: Json | undefined, saved: ReadonlyMap<string, string>): Json | undefined => {
    if (Array.isArray(value)) {
        return value.map((entry: Json) => withSavedPaths(entry, saved) ?? null);
    }
    if (value instanceof Object) {
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, withSavedPaths(entry, saved)]));
    }
    return value === String(value) ? (saved.get(value) ?? value) : value;
};

/** Saves what one `run` answered (attachments, downloads) and answers its output naming where each landed. */
export const saveAnswer = async (root: string, answer: RunAnswer, http: Http = fetch): Promise<Json | undefined> => {
    const saved = new Map<string, string>();
    for (const file of answer.files) {
        saved.set(file.path, await saveBytes(root, file.path, Buffer.from(file.data, "base64")));
    }
    for (const download of answer.downloads) {
        saved.set(download.path, await fetchDownload(root, download.path, download.url, http));
    }
    // SAFETY: the command's output is Graph's JSON, or what became of an action, both JSON.
    return withSavedPaths(answer.output as Json | undefined, saved);
};
