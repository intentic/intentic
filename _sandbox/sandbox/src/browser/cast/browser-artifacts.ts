import { basename, extname, join, relative, resolve, sep } from "node:path";
import { pathExists } from "@intentic/base/fs";
import type { ToolCallContent } from "@intentic/sandbox-contract/events/requests";
import { stateRelPath } from "../../state-paths.js";
import { insideRel } from "@intentic/base/contained";

// Directory every artifact belongs in, outside every repo, so it never reaches the Changes panel or a commit.
export const BROWSER_OUTPUT_REL = stateRelPath(".intentic/records/artifacts/browser/");

export const browserOutputDir = (root: string): string => join(root, BROWSER_OUTPUT_REL);

// Inverse of browserOutputDir, so the two can't drift; the web fetches a screenshot by a workspace-root-relative name.
// The climb is counted off BROWSER_OUTPUT_REL rather than hardcoded, so a deeper output path can't silently break it.
const rootOf = (outputDir: string): string => resolve(outputDir, ...BROWSER_OUTPUT_REL.split("/").map(() => ".."));

// `--output-dir` only covers playwright's own auto-named files; once the model passes `filename`, the tool resolves it
// against ITS OWN working directory, which is the daemon's: the main tree's workspace root, not the conversation's
// worktree. A Codex turn's `filename: "after.png"` used to land as /work/after.png in the owner's tree while the agent,
// looking at /work in its own worktree, found nothing there (brisk-arrow-qufn, spry-sage-81k7, 2026-10-26). The
// placement below runs in the router (browser-router.ts), the one place every runtime's browser call passes, so no
// runtime depends on a hook of its own loop to keep files out of the owner's tree.

// @playwright/mcp's own name for the tool, whatever server prefix a runtime puts in front of it.
export const SCREENSHOT_VERB = "browser_take_screenshot";

// The tools whose `filename` names a file to READ (code to run, a storage state to restore), left as asked. Every other
// @playwright/mcp tool's `filename` is a file it writes (a screenshot, a snapshot, console or network dumps, a pdf, a
// video, a storage state), so a tool upstream adds later is placed by default rather than writing into the owner's tree.
// A page's own WebMCP tool (`webmcp_…`) is not upstream's, and its `filename` means whatever the page says it means.
const FILENAME_READERS: ReadonlySet<string> = new Set(["browser_run_code_unsafe", "browser_set_storage_state"]);

export const writesFilename = (tool: string): boolean => tool.startsWith("browser_") && !FILENAME_READERS.has(tool);

// Keeps the agent's chosen name, deciding only location: a name resolving outside the output dir keeps just its
// basename, anything already inside (including a subdirectory) is left as asked.
const inOutputDir = (outputDir: string, filename: string): string => {
    const resolved = resolve(outputDir, filename);
    const rel = insideRel(outputDir, resolved);
    return rel !== undefined && rel !== "" ? resolved : join(outputDir, basename(filename));
};

// Past this many numbered names the shot takes a clock suffix instead, so a `taken` that always answers yes can't hang
// the call.
const MAX_NUMBERED = 1000;

// A shot already on disk is some transcript's picture: a later one with the same name takes the next free number
// (`after-2.png`), never its place.
const freeName = async (target: string, taken: (path: string) => Promise<boolean>): Promise<string> => {
    const ext = extname(target);
    const stem = target.slice(0, target.length - ext.length);
    for (let n = 1; n <= MAX_NUMBERED; n += 1) {
        const candidate = n === 1 ? target : `${stem}-${n}${ext}`;
        if (!(await taken(candidate))) {
            return candidate;
        }
    }
    return `${stem}-${Date.now()}${ext}`;
};

// Where a file the model named is written: inside the output dir, under a name no earlier file holds. Absolute, so
// what the backend resolves it against no longer matters.
export const placeArtifact = async (outputDir: string, filename: string, taken: (path: string) => Promise<boolean> = pathExists): Promise<string> =>
    freeName(inOutputDir(outputDir, filename), taken);

// What the agent is told beside the tool's own answer when its name was moved: the answer's link is relative to the
// backend's directory, and a turn that went looking where it asked would find nothing.
export const placedNote = (asked: string, placed: string, outputDir: string): string =>
    `Saved to ${placed}${basename(placed) === basename(asked) ? "" : " (an earlier file already has that name)"}: files a browser ` +
    `tool writes always land in ${outputDir}, outside every repository. Read it from that absolute path.`;

// @playwright/mcp's answer (a markdown link relative to the agent's cwd, or a bare image block) renders as nothing.
// Pulled back out and returned workspace-relative, only when inside the output dir.
const MARKDOWN_LINK = /]\(([^)]+)\)/g;

export const screenshotImage = (resultText: string, cwd: string, outputDir: string): ToolCallContent | undefined => {
    const root = rootOf(outputDir);
    for (const [, link] of resultText.matchAll(MARKDOWN_LINK)) {
        if (link === undefined) {
            continue;
        }
        const abs = resolve(cwd, link);
        const inOutput = insideRel(outputDir, abs);
        if (inOutput === undefined || inOutput === "") {
            continue;
        }
        return { type: "image", path: relative(root, abs).split(sep).join("/") };
    }
    return undefined;
};
