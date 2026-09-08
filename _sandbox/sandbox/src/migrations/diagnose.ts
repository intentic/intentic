import type { Files } from "./adapter-shared.js";

// Explains why an upload wasn't recognized, in terms of what was actually in it, not by repeating the packing
// instruction. Four cases, each with a different next move:
// - empty archive: the pack command errored silently
// - workspace files, no config: they packed the workspace folder, not the whole setup folder
// - home directory: they packed ~, and the setup folder is somewhere inside it
// - something else: names what the top level actually holds

const ANCHORS = ["config.yaml", "openclaw.json"];
// Files that exist only in a tool's workspace; seeing one without a config is the single most common near-miss.
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
