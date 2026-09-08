import { basename, join, relative, resolve, sep } from "node:path";
import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import type { ToolCallContent } from "@intentic/sandbox-contract";
import { stateRelPath } from "../../workspace/layout/state-paths.js";

// Directory every artifact belongs in, outside every repo, so it never reaches the Changes panel or a commit.
const BROWSER_OUTPUT_REL = stateRelPath(".intentic/records/artifacts/", "browser");

export const browserOutputDir = (root: string): string => join(root, BROWSER_OUTPUT_REL);

// Inverse of browserOutputDir, so the two can't drift; the web fetches a screenshot by a workspace-root-relative name.
// The climb is counted off BROWSER_OUTPUT_REL rather than hardcoded, so a deeper output path can't silently break it.
const rootOf = (outputDir: string): string => resolve(outputDir, ...BROWSER_OUTPUT_REL.split("/").map(() => ".."));

// `--output-dir` only covers playwright's own auto-named files; once the model passes `filename`, the tool resolves it
// against the agent's cwd and writes straight into the repo instead.

// Matches both browser kinds: the always-on `web` server and the routed logged-in one; segment unconstrained.
const SCREENSHOT_TOOL = "mcp__.+__browser_take_screenshot";

// Keeps the agent's chosen name, deciding only location: a name resolving outside the output dir keeps just its
// basename, anything already inside (including a subdirectory) is left as asked.
const inOutputDir = (outputDir: string, filename: string): string => {
    const resolved = resolve(outputDir, filename);
    const rel = relative(outputDir, resolved);
    return rel !== "" && !rel.startsWith("..") ? resolved : join(outputDir, basename(filename));
};

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
                            // Tool's answer is relative to the agent's cwd, a climb out and back; say the absolute path
                            // instead.
                            additionalContext: `Screenshot saved to ${target}, Read it from that absolute path.`,
                        },
                    };
                },
            ],
        },
    ],
});
