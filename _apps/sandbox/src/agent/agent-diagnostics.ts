import { extname } from "node:path";
import { diagnoseVia } from "@intentic/lsp/client";
import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { inWorktree, type IsolationPlan } from "../agents/isolation.js";
import { modulesNear, type NearbyModules } from "../workspace/dependency-drift.js";

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
 * nothing. See workspace-setup.ts for the readiness model this mirrors.
 *
 * A PARTIALLY installed tree is the same failure wearing a disguise, and it is the one this workspace actually
 * produces. node_modules exists, so the old gate opened; the dependency the agent added two edits ago is not in
 * it, so every import of it reports TS2307 — a real diagnostic code, on the real line, naming a real package,
 * and completely uninformative about what is wrong. The model's cheapest reading of that is "I got the import
 * wrong", and what follows is an edit to correct source. So the gate now asks the question it always meant:
 * not "is there a node_modules" but "can this file's package resolve what it declares" (dependency-drift.ts).
 * Diagnostics still run — the rest of the file's errors are real and worth having — with the cause named
 * alongside them so an unresolved import is read as the install being behind rather than as a mistake. */

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

// What is wrong with this file's installed tree, if anything. Injectable so tests need no fixture tree.
export type ModulesProbe = (file: string) => Promise<NearbyModules>;

// How many missing names the model is shown. Enough to recognise which dependency it just added; a longer list
// is the same fact repeated.
const NAMED_MISSING = 3;

const ABSENT_NOTE =
    "Type diagnostics are unavailable for this edit: dependencies are not installed (no node_modules resolves " +
    "from this file), so a type-check would report every import as broken regardless of the edit. Install them " +
    "before trusting any type-check, lint or test result here.";

/* Said ALONGSIDE the diagnostics rather than instead of them, which is the difference between this and the
 * absent case. A tree missing one package still type-checks everything else correctly, so suppressing the whole
 * report would throw away real errors the edit introduced; what the model needs is the one sentence that stops
 * it misreading the errors about THOSE names. It is also told not to install, because in an isolated turn the
 * install would land in an overlay that dies with the conversation (agents/isolation.ts) — the daemon
 * reconciles the real tree once the workspace is idle. */
const staleNote = (missing: readonly string[]): string =>
    `Note: this package declares ${missing.length} ${missing.length === 1 ? "dependency" : "dependencies"} that ` +
    `${missing.length === 1 ? "is" : "are"} not installed (${missing.slice(0, NAMED_MISSING).join(", ")}${
        missing.length > NAMED_MISSING ? `, and ${missing.length - NAMED_MISSING} more` : ""
    }). Unresolved-import errors naming ${missing.length === 1 ? "it" : "those"} are the install being behind, not ` +
    "a mistake in this code — do not edit working source to satisfy one, and do not run an install; the workspace " +
    "reconciles itself once it is idle.";

// PostToolUse on the native Edit/Write: type-check the touched file and feed compile errors back. Silent on
// clean files, non-TS files, and any failure — feedback must never break or stall an edit. Created once
// per turn (baseOptions), so `explained` scopes each standing notice to one telling per turn: the model needs
// a reason once, not stapled to every edit it makes for the rest of the conversation.
export const editDiagnosticsHooks = (
    cwd: string,
    // An isolated turn names its files inside its own namespace (/work/...), which from the daemon — where
    // this hook body and the resident type-checker both run — is the MAIN checkout: the same path, a different
    // file. Everything below therefore works on the translated path, and only the message the agent reads
    // keeps the name the agent used.
    isolation?: IsolationPlan,
    diag: DiagRunner = runResidentDiag,
    modules: ModulesProbe = modulesNear,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> => {
    // Per PACKAGE, not per turn: a turn that edits two packages has two different answers to give, and one
    // shared flag would silence whichever it reached second. The absent case keys on "" — there is only ever
    // one of it worth saying.
    const explained = new Set<string>();
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
                        const target = inWorktree(file, isolation);
                        const nearby = await modules(target);
                        if (nearby.kind === "absent") {
                            if (explained.has("")) {
                                return {};
                            }
                            explained.add("");
                            return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: ABSENT_NOTE } };
                        }
                        // Keyed by the names themselves: an install that fixed half the list has changed what
                        // the model needs to know, and should be allowed to say so again.
                        const key = nearby.missing.join(",");
                        const stale = nearby.missing.length > 0 && !explained.has(key);
                        if (stale) {
                            explained.add(key);
                        }
                        const output = await diag(target, cwd);
                        const errors = output === undefined ? undefined : errorLines(output);
                        if (errors === undefined) {
                            // Nothing to report about the edit itself — but a first sighting of a drifted tree
                            // is still worth the one sentence, because the next tool the model reaches for
                            // (a test, a lint) will fail on the same missing package.
                            return stale
                                ? { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: staleNote(nearby.missing) } }
                                : {};
                        }
                        return {
                            hookSpecificOutput: {
                                hookEventName: "PostToolUse",
                                additionalContext:
                                    `TypeScript diagnostics for ${file} after this edit:\n${errors}\n` +
                                    `${stale ? `${staleNote(nearby.missing)}\n` : ""}Fix the errors this edit introduced before finishing.`,
                            },
                        };
                    },
                ],
            },
        ],
    };
};
