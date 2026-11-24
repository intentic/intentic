import { diffContent, pathUnder, toolLocations as locationsUnder } from "@intentic/acp-events/tool-cards";
import type { ToolCallContent, ToolCallLocation } from "@intentic/sandbox-contract/events/requests";
import { SCREENSHOT_VERB, screenshotImage } from "../../browser/cast/browser-artifacts.js";
import { claudeStatePath } from "../session-store.js";

// What the daemon's cards need of a tool call beyond its name and kind (those, and the turn readings' questions, are
// runtime-neutral and live in @intentic/agent-context/tool-calls): result text, pictures, workspace locations and diff
// content, derived from any backend's native stream. Every adapter maps through these instead of keeping its own copy.
// The parts a computer's turns build too (a card's bounded input and own words, a diff's two sides, a path read against
// the turn's folder) live in @intentic/acp-events/tool-cards, and are handed on here under the names the daemon's
// adapters import them by.
export { diffContent, TOOL_INPUT_CHARS, toolDescription, toolInput } from "@intentic/acp-events/tool-cards";

// Flattens a tool_result block's content (string or array of text/other blocks) to plain text; non-text blocks
// summarize by type. Shared by the live stream and session restore so a replayed card matches the original.
export const resultText = (content: unknown): string => {
    if (typeof content === "string") {
        return content;
    }
    if (!Array.isArray(content)) {
        return "";
    }
    return content
        .map((block) => {
            const b = block as { type?: string; text?: string };
            return b.type === "text" && typeof b.text === "string" ? b.text : `[${b.type ?? "block"}]`;
        })
        .join("");
};

// A call as its native stream named it, which is what a finished answer is read against.
export interface CalledTool {
    readonly name: string;
    readonly input: unknown;
}

// @playwright/mcp's screenshot under either server spelling a runtime uses (`mcp__web__…`, `web.…`).
const isScreenshotCall = (name: string): boolean => name.endsWith(`__${SCREENSHOT_VERB}`) || name.endsWith(`.${SCREENSHOT_VERB}`);

// The two calls whose answer can be a picture, so a stream remembers only those inputs until their result.
export const mayShowPicture = (name: string): boolean => name === "Read" || isScreenshotCall(name);

// Words only: once the picture itself is carried, an `[image]` placeholder stands in for nothing.
const wordsOf = (content: unknown): string =>
    Array.isArray(content)
        ? content
              .map((block) => {
                  const b = block as { type?: string; text?: string };
                  return b.type === "text" && typeof b.text === "string" ? b.text : "";
              })
              .join("")
        : resultText(content);

// The file a successful answer shows, as a workspace path: a screenshot names the file it wrote, and a Read that
// answered with an image block read the file it was given.
const pictureOf = (call: CalledTool, content: unknown, cwd: string, outputDir: string | undefined): ToolCallContent | undefined => {
    if (isScreenshotCall(call.name)) {
        return outputDir === undefined ? undefined : screenshotImage(resultText(content), cwd, outputDir);
    }
    if (call.name !== "Read" || !Array.isArray(content) || !content.some((block) => (block as { type?: unknown }).type === "image")) {
        return undefined;
    }
    const path = toolLocations(call.input, cwd)?.[0]?.path;
    return path === undefined ? undefined : { type: "image", path };
};

// What an answer puts on its card; `call` is the remembered call (mayShowPicture) of a SUCCESSFUL result, absent
// otherwise. Shared by the live stream and session restore so a replayed card matches the original.
export const resultContent = (content: unknown, cwd: string, outputDir: string | undefined, call: CalledTool | undefined): ToolCallContent[] => {
    const picture = call === undefined ? undefined : pictureOf(call, content, cwd, outputDir);
    if (picture === undefined) {
        return [{ type: "text", text: resultText(content) }];
    }
    const words = wordsOf(content);
    return words === "" ? [picture] : [{ type: "text", text: words }, picture];
};


// Normalizes a tool path onto the workspace-root-relative, forward-slash route space; undefined if it escapes the
// workspace. Relative inputs are cwd-relative, which is already the route space.
export const workspacePath = (raw: string, cwd: string): string | undefined =>
    // A `~/.claude/...` path is not an escape: it symlinks onto the workspace, resolved before the cwd test.
    claudeStatePath(raw) ?? pathUnder(raw, cwd);

// Workspace files a tool call touches, for clickable cards and live-writes; `line` comes from Read's 1-based `offset`.
// Undefined when the input names no workspace-addressable file.
export const toolLocations = (input: unknown, cwd: string): ToolCallLocation[] | undefined => locationsUnder(input, cwd, workspacePath);

// Structured diff content derived from an Edit/Write-style input, known at call time; handles both spelling families.
// Unrecognized shapes degrade to undefined, never throw; a workspace-escaping path is kept as-is for display.
export const editDiffContent = (name: string, input: unknown, cwd: string): ToolCallContent | undefined => {
    if (typeof input !== "object" || input === null) {
        return undefined;
    }
    const record = input as Record<string, unknown>;
    // OpenCode 2's edit and write name their file `path`.
    const rawPath = record["file_path"] ?? record["filePath"] ?? record["notebook_path"] ?? record["path"];
    if (typeof rawPath !== "string") {
        return undefined;
    }
    const path = workspacePath(rawPath, cwd) ?? rawPath;
    if (name === "Edit") {
        const oldText = record["old_string"] ?? record["oldString"];
        const newText = record["new_string"] ?? record["newString"];
        if (typeof oldText !== "string" || typeof newText !== "string") {
            return undefined;
        }
        return diffContent(path, oldText, newText);
    }
    if (name === "Write" || name === "NotebookEdit") {
        const content = record[name === "Write" ? "content" : "new_source"];
        if (typeof content !== "string") {
            return undefined;
        }
        return diffContent(path, undefined, content);
    }
    return undefined;
};
