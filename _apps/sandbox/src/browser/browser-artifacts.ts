import { basename, join, relative, resolve, sep } from "node:path";
import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import type { ToolCallContent } from "@intentic/sandbox-contract";

// The one directory every browser artifact belongs in. It sits outside every repo of the workspace (the root
// repo excludes `/.intentic/`), so nothing written here can reach the user's Changes panel or a commit.
export const browserOutputDir = (root: string): string => join(root, ".intentic", "browser", "output");

// Its inverse, so the two can't drift. A screenshot has to be named in the WORKSPACE-ROOT-relative route space
// for the web to fetch it (/workspace/raw), and the output dir is the only thing the turn carries that knows
// where that root is — see AgentRequest.browserOutputDir.
const rootOf = (outputDir: string): string => resolve(outputDir, "..", "..", "..");

/* Why a hook has to enforce that directory.
 *
 * `--output-dir` (isolatedBrowserSpec) governs only the artifacts @playwright/mcp names ITSELF — page-*.yml,
 * console-*.log, downloads. The moment the model passes `filename`, the tool takes a different path entirely:
 * `resolveClientFile` sends a model-supplied name through `workspaceFile`, which resolves it against the MCP
 * CLIENT's workspace — the agent's cwd — and writes the screenshot straight into the repo the agent is
 * working in. The tool's own schema ("Prefer relative file names to stay within the output directory") says
 * the opposite of what it does, so an agent following the instructions still litters.
 *
 * That is how four PNGs from a tooltip session reached the workspace root: written to the worktree's cwd,
 * swept up by the `git add -A` that preserves a worktree's uncommitted state at land time (agents/land.ts),
 * then patch-applied into /work as changes the user had to review and delete. Had they been in this
 * directory, `add -A` would never have seen them.
 *
 * Prompting cannot fix this. It was already tried and it is in the system prompt: one session believed it,
 * tried to Read the screenshot out of the output dir, got "File does not exist", and burned a `find /` to
 * locate the file — while another session, same tools, same prompt, never checked and left the mess behind.
 * The layer that dictates the path is the layer that has to dictate it for named files too. */

// Both browser kinds: the always-on `web` server and a logged-in capability's own (`mcp__reddit__…`).
// Capability ids may hold any character an id allows, so the middle segment stays unconstrained.
const SCREENSHOT_TOOL = "mcp__.+__browser_take_screenshot";

// The agent's chosen NAME is kept — only its location is decided here. A name that would resolve outside the
// output dir (absolute, or climbing with `..`) keeps just its basename; anything already inside it, including
// a subdirectory the agent asked for, is left where it asked.
const inOutputDir = (outputDir: string, filename: string): string => {
    const resolved = resolve(outputDir, filename);
    const rel = relative(outputDir, resolved);
    return rel !== "" && !rel.startsWith("..") ? resolved : join(outputDir, basename(filename));
};

/* THE SCREENSHOT THE USER NEVER SAW.
 *
 * @playwright/mcp answers a screenshot with a markdown link to the file it wrote — `- [Screenshot of
 * viewport](../../.intentic/browser/output/page-….png)`, relative to the AGENT'S cwd — and, when the model
 * named no file, an image block besides. The chat rendered neither: non-text result blocks collapse to the
 * literal string "[image]" (resultText), and a relative path climbing out of a repo is not something the
 * client can fetch. So a turn that screenshotted the user's own app showed them a card that said `[image]`.
 *
 * This is the other end of that: pull the path back out of the answer, prove it really is one of ours (inside
 * the output dir this module dictates), and hand it over as a workspace path the chat can render and the user
 * can open. Undefined for anything else, including a screenshot that somehow landed elsewhere — a picture we
 * can't place is one we shouldn't claim. */
const MARKDOWN_LINK = /]\(([^)]+)\)/g;

export const screenshotImage = (resultText: string, cwd: string, outputDir: string): ToolCallContent | undefined => {
    const root = rootOf(outputDir);
    for (const [, link] of resultText.matchAll(MARKDOWN_LINK)) {
        if (link === undefined) {
            continue;
        }
        const abs = resolve(cwd, link);
        const inOutput = relative(outputDir, abs);
        if (inOutput === "" || inOutput.startsWith("..")) {
            continue;
        }
        return { type: "image", path: relative(root, abs).split(sep).join("/") };
    }
    return undefined;
};

export const browserArtifactHooks = (outputDir: string): Partial<Record<HookEvent, HookCallbackMatcher[]>> => ({
    PreToolUse: [
        {
            matcher: SCREENSHOT_TOOL,
            hooks: [
                async (input) => {
                    if (input.hook_event_name !== "PreToolUse") {
                        return {};
                    }
                    const toolInput = input.tool_input as { filename?: unknown };
                    const { filename } = toolInput;
                    // No name ⇒ the tool timestamps one into `--output-dir` already; nothing to redirect.
                    if (typeof filename !== "string" || filename === "") {
                        return {};
                    }
                    const target = inOutputDir(outputDir, filename);
                    if (target === filename) {
                        return {};
                    }
                    return {
                        hookSpecificOutput: {
                            hookEventName: "PreToolUse",
                            updatedInput: { ...toolInput, filename: target },
                            // The tool answers with a path relative to the agent's cwd, which is now a climb
                            // out of the repo and back down — useless to Read. Say where the file actually is.
                            additionalContext: `Screenshot saved to ${target} — Read it from that absolute path.`,
                        },
                    };
                },
            ],
        },
    ],
});
