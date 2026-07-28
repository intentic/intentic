import { basename, join, relative, resolve } from "node:path";
import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";

// The one directory every browser artifact belongs in. It sits outside every repo of the workspace (the root
// repo excludes `/.intentic/`), so nothing written here can reach the user's Changes panel or a commit.
export const browserOutputDir = (root: string): string => join(root, ".intentic", "browser", "output");

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
