import type { Files } from "./adapter-shared.js";

/* WHY AN UPLOAD WAS NOT RECOGNIZED, said in terms of what was actually in it.
 *
 * The first version answered every unrecognized archive by repeating the packing instruction, the one thing
 * the user had already tried and which had already failed them. An upload arrives after a real chore (pack on
 * a server, copy the file over, find it in a dialog), so the answer has to move them forward: the reader holds
 * the whole file list, so it can say which mistake this is.
 *
 * Four mistakes cover nearly all of it, and each has a different next move:
 *   an empty archive         , the pack command errored and they did not see it
 *   workspace files, no config- they packed the workspace folder instead of the whole setup folder
 *   a home directory         , they packed `~` and the setup folder is somewhere in it (or not)
 *   something else entirely  , name what the top level actually holds, so they can see the mismatch
 */

const ANCHORS = ["config.yaml", "openclaw.json"];
// Files that only exist inside one of these tools' WORKSPACES, seeing them without a config is the single
// most common near-miss, because the workspace is the folder a user thinks of as "my assistant's stuff".
const WORKSPACE_MARKERS = ["SOUL.md", "AGENTS.md", "IDENTITY.md", "MEMORY.md", "USER.md", "HEARTBEAT.md"];

const topLevel = (files: Files): string[] => [...new Set([...files.keys()].map((path) => path.split("/")[0] ?? path))].toSorted();

export const diagnoseArchive = (files: Files): string => {
    if (files.size === 0) {
        return "That archive is empty. The pack command usually prints an error when the folder name is wrong: run it again and read what it says before uploading.";
    }
    const names = [...files.keys()];
    const hasAnchor = names.some((path) => ANCHORS.some((anchor) => path === anchor || path.endsWith(`/${anchor}`)));
    const marker = WORKSPACE_MARKERS.find((candidate) => names.some((path) => path === candidate || path.endsWith(`/${candidate}`)));
    if (!hasAnchor && marker !== undefined) {
        return `This looks like just the workspace folder: I can see ${marker}, but not the settings file beside it. Pack the whole assistant folder (the one that also holds the settings file), not only the workspace inside it.`;
    }
    const top = topLevel(files);
    if (top.length > 12) {
        return `This looks like a whole home directory: ${files.size} files across ${top.length} folders, with no assistant settings file among them. Pack just the assistant's own folder.`;
    }
    const listed = top.slice(0, 6).join(", ");
    return `I read ${files.size} file${files.size === 1 ? "" : "s"} and found no assistant settings file. The archive holds: ${listed}${
        top.length > 6 ? ", …" : ""
    }. If your setup lives somewhere unusual, pack that folder itself.`;
};
