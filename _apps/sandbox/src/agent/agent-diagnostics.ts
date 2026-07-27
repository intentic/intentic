import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";

/* Post-edit diagnostics feedback — the VSCode Claude Code loop, reproduced daemon-side: after every native
 * Edit/Write the baked `lsp` CLI type-checks the touched file, and any COMPILE ERRORS ride back to the model
 * as additionalContext on the tool result, so it self-corrects inside the same turn instead of leaving broken
 * code for the user to find. Push, not pull: the lsp skill (settings/skills.ts) stays the model-invoked verb;
 * this hook fires regardless of whether that skill is enabled.
 *
 * The whole loop is GATED on the dependencies actually being installed. Without node_modules the compiler
 * cannot resolve a single import — not even `node:path`, whose types ship in @types/node — so it reports
 * hundreds of errors on lines the edit never touched, and every one of them is an artifact of the missing
 * install. That is worse than silence: it is confident, specific, wrong feedback, and the model spends real
 * reasoning deciding to distrust it. So when the modules aren't there we say exactly that, once, and check
 * nothing. See workspace-setup.ts for the readiness model this mirrors. */

const execFileAsync = promisify(execFile);

// The lsp CLI is TypeScript/JavaScript only — other files are never checked.
const CHECKED_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

// Bound the feedback so a cascading break can't flood the transcript: errors only, first lines, capped chars.
const MAX_LINES = 20;
const MAX_CHARS = 4_000;
const DIAG_TIMEOUT_MS = 15_000;

// Run `lsp diag` for one file, returning raw stdout — undefined on any failure (missing binary, crash,
// timeout). Injected into the hook for tests.
export type DiagRunner = (file: string, cwd: string) => Promise<string | undefined>;

// After the first ENOENT (local dev without the baked binary) the hook self-disables for the process.
let lspMissing = false;

const runLspDiag: DiagRunner = async (file, cwd) => {
    if (lspMissing) {
        return undefined;
    }
    try {
        const { stdout } = await execFileAsync("lsp", ["diag", file], { cwd, timeout: DIAG_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
        return stdout;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            lspMissing = true;
        }
        return undefined;
    }
};

// Compress diag output to the error lines the model must act on. Warnings/suggestions are dropped — they'd
// steer the model into unrequested cleanup; "no diagnostics" (or only non-errors) yields undefined.
const errorLines = (output: string): string | undefined => {
    const lines = output
        .split("\n")
        .filter((line) => line.includes(": error TS"))
        .slice(0, MAX_LINES);
    if (lines.length === 0) {
        return undefined;
    }
    return lines.join("\n").slice(0, MAX_CHARS);
};

// Can the compiler resolve imports for this file at all? Mirrors TypeScript's own algorithm — walk up from the
// file looking for a node_modules — so the answer is exactly "will the diagnostics mean anything". Injectable
// so tests need no fixture tree.
export type ModulesProbe = (file: string) => Promise<boolean>;

const hasResolvableModules: ModulesProbe = async (file) => {
    for (let dir = dirname(resolve(file)); ;) {
        try {
            await access(join(dir, "node_modules"));
            return true;
        } catch {
            const parent = dirname(dir);
            if (parent === dir) {
                return false;
            }
            dir = parent;
        }
    }
};

// PostToolUse on the native Edit/Write: type-check the touched file and feed compile errors back. Silent on
// clean files, non-TS files, and any lsp failure — feedback must never break or stall an edit. Created once
// per turn (baseOptions), so `explained` scopes the missing-dependency notice to one telling per turn: the
// model needs the reason once, not stapled to every edit it makes for the rest of the conversation.
export const editDiagnosticsHooks = (
    cwd: string,
    diag: DiagRunner = runLspDiag,
    modules: ModulesProbe = hasResolvableModules,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> => {
    let explained = false;
    return {
        PostToolUse: [
            {
                matcher: "Edit|Write",
                hooks: [
                    async (input) => {
                        if (input.hook_event_name !== "PostToolUse") {
                            return {};
                        }
                        const file = (input.tool_input as { file_path?: unknown }).file_path;
                        if (typeof file !== "string" || !CHECKED_EXTENSIONS.has(extname(file))) {
                            return {};
                        }
                        if (!(await modules(file))) {
                            if (explained) {
                                return {};
                            }
                            explained = true;
                            return {
                                hookSpecificOutput: {
                                    hookEventName: "PostToolUse",
                                    additionalContext:
                                        "Type diagnostics are unavailable for this edit: dependencies are not installed (no node_modules resolves " +
                                        "from this file), so a type-check would report every import as broken regardless of the edit. Install them " +
                                        "before trusting any type-check, lint or test result here.",
                                },
                            };
                        }
                        const output = await diag(file, cwd);
                        if (output === undefined) {
                            return {};
                        }
                        const errors = errorLines(output);
                        if (errors === undefined) {
                            return {};
                        }
                        return {
                            hookSpecificOutput: {
                                hookEventName: "PostToolUse",
                                additionalContext: `TypeScript diagnostics for ${file} after this edit:\n${errors}\nFix the errors this edit introduced before finishing.`,
                            },
                        };
                    },
                ],
            },
        ],
    };
};
