import { access } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { diagnoseVia } from "@intentic/lsp/client";
import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { fromNamespace, type IsolationPlan } from "../agents/isolation.js";

/* Post-edit diagnostics feedback — the VSCode Claude Code loop, reproduced daemon-side: after every native
 * Edit/Write the touched file is type-checked and any COMPILE ERRORS ride back to the model as additionalContext,
 * so it self-corrects inside the same turn instead of leaving broken code for the user to find. VS Code gets this
 * for free because its language server is already resident and has already computed the markers; the sandbox has
 * no editor, so it keeps its own resident service (`lsp daemon`) and reads from that.
 *
 * That residency is the difference between a check worth running and one that isn't. Building a monorepo
 * package's LanguageService from cold costs ~1.7s, which is what this hook used to pay on EVERY edit by shelling
 * out to `lsp diag`; against a warm program the same question is a re-check of what actually moved. The daemon is
 * started by the first edit that has a tsconfig above it and exits on its own once the workspace goes quiet, so a
 * repo with no TypeScript in it never starts one.
 *
 * The whole loop is GATED on the dependencies actually being installed. Without node_modules the compiler
 * cannot resolve a single import — not even `node:path`, whose types ship in @types/node — so it reports
 * hundreds of errors on lines the edit never touched, and every one of them is an artifact of the missing
 * install. That is worse than silence: it is confident, specific, wrong feedback, and the model spends real
 * reasoning deciding to distrust it. So when the modules aren't there we say exactly that, once, and check
 * nothing. See workspace-setup.ts for the readiness model this mirrors. */

// The language service is TypeScript/JavaScript only — other files are never checked.
const CHECKED_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

// Bound the feedback so a cascading break can't flood the transcript: errors only, first lines, capped chars.
const MAX_LINES = 20;
const MAX_CHARS = 4_000;

// Ask the resident service about one file. Undefined means "no answer to be had" — no TypeScript project above
// the file, or no daemon we could reach — which must stay distinguishable from "checked, and clean".
export type DiagRunner = (file: string, cwd: string) => Promise<readonly string[] | undefined>;

const runResidentDiag: DiagRunner = async (file, cwd) => {
    const diagnostics = await diagnoseVia(cwd, { files: [file], touched: [file] });
    return diagnostics?.map((d) => `${d.file}:${d.line}:${d.column}: ${d.category} TS${d.code}: ${d.message}`);
};

// Compress to the error lines the model must act on. Warnings/suggestions are dropped — they'd steer the model
// into unrequested cleanup; a clean file (or one with only non-errors) yields undefined.
const errorLines = (lines: readonly string[]): string | undefined => {
    const errors = lines.filter((line) => line.includes(": error TS")).slice(0, MAX_LINES);
    return errors.length === 0 ? undefined : errors.join("\n").slice(0, MAX_CHARS);
};

// Can the compiler resolve imports for this file at all? Mirrors TypeScript's own algorithm — walk up from the
// file looking for a node_modules — so the answer is exactly "will the diagnostics mean anything". Injectable
// so tests need no fixture tree.
export type ModulesProbe = (file: string) => Promise<boolean>;

const hasResolvableModules: ModulesProbe = async (file) => {
    for (let dir = dirname(resolve(file)); ; ) {
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
// clean files, non-TS files, and any failure — feedback must never break or stall an edit. Created once
// per turn (baseOptions), so `explained` scopes the missing-dependency notice to one telling per turn: the
// model needs the reason once, not stapled to every edit it makes for the rest of the conversation.
export const editDiagnosticsHooks = (
    cwd: string,
    // An isolated turn names its files inside its own namespace (/work/...), which from the daemon — where
    // this hook body and the resident type-checker both run — is the MAIN checkout: the same path, a different
    // file. Everything below therefore works on the translated path, and only the message the agent reads
    // keeps the name the agent used.
    isolation?: IsolationPlan,
    diag: DiagRunner = runResidentDiag,
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
                        const target = fromNamespace(file, isolation);
                        if (!(await modules(target))) {
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
                        const output = await diag(target, cwd);
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
