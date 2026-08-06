import { extname } from "node:path";
import { diagnoseVia, type ServiceLocation } from "@intentic/lsp/client";
import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { fromWorktree, inWorktree, nsenterArgv, type TurnPlacement } from "../agents/isolation.js";
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
// `unavailable` is the daemon itself refusing: it reached the file's project and could not load it well enough
// to vouch for anything, so it checked nothing rather than answer from a half-loaded program. The refusal reason
// names service-side paths the agent may have no window onto, so it is not carried here — the notice below says
// what is true from here.
export type DiagAnswer = { readonly kind: "checked"; readonly lines: readonly string[] } | { readonly kind: "unavailable" };

// One file's check, and everything about WHERE it is asked. `service` places the language service in the view
// the paths are named for (undefined when that is this process's own), and `named` turns a file the service
// reported back into the name the agent uses for it — identity when the two stand in the same view.
export interface DiagRequest {
    readonly file: string;
    readonly cwd: string;
    readonly service: ServiceLocation | undefined;
    readonly named: (file: string) => string;
}

export type DiagRunner = (request: DiagRequest) => Promise<DiagAnswer | undefined>;

const runResidentDiag: DiagRunner = async ({ file, cwd, service, named }) => {
    const report = await diagnoseVia(cwd, { files: [file], touched: [file], ...(service !== undefined ? { service } : {}) });
    if (report === undefined) {
        return undefined;
    }
    if (report.unavailable.length > 0) {
        return { kind: "unavailable" };
    }
    return {
        kind: "checked",
        lines: report.diagnostics.map((d) => `${named(d.file)}:${d.line}:${d.column}: ${d.category} TS${d.code}: ${d.message}`),
    };
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

/* WHAT THIS NOTE MAY AND MAY NOT CLAIM, now that three different states reach it.
 *
 * One is a tree nobody has installed (dependency-drift.ts). One is an install this process cannot SEE — an
 * isolated turn's node_modules is mounted inside the turn's namespace, so the daemon finds an empty directory
 * where the agent finds 34 packages. And one is the type-checker itself refusing: the project's config chain or
 * type foundations would not load from where it stands, so it declined to answer at all rather than report the
 * phantom errors a half-loaded program produces (@intentic/lsp). They are one fact for this hook's purposes —
 * no truthful diagnostics from here — and completely different facts for the agent, which is why the sentence
 * names no cause and prescribes no install: told "dependencies are not installed" an agent whose own type-check
 * passes either distrusts working tooling or goes looking for an install that would land in an overlay and die
 * with the conversation.
 *
 * So it says only what is known from here, and points at the check that CAN answer — the package's own. */
const UNAVAILABLE_NOTE =
    "Type diagnostics are unavailable for this edit: the type-checker cannot resolve this package's dependencies " +
    "from where it runs, so it would report every import as broken whatever the edit did. That is a limit of this " +
    "check, not a verdict on your tools or on the code — run the package's own type-check, lint or tests when you " +
    "need this file verified.";

/* Said ALONGSIDE the diagnostics rather than instead of them, which is the difference between this and the
 * absent case. A tree missing one package still type-checks everything else correctly, so suppressing the whole
 * report would throw away real errors the edit introduced; what the model needs is the one sentence that stops
 * it misreading the errors about THOSE names. It is also told not to install, because in an isolated turn the
 * install would land in an overlay that dies with the conversation (agents/isolation.ts) — the daemon reconciles
 * the real tree instead, and it does so once this turn ENDS. Stated that way for the reason workspace-setup.ts
 * sets out at length: the reconciler defers while a turn is live, so an agent promised relief "once the
 * workspace is idle" is promised something its own working prevents, with no signal for when it arrives. */
const staleNote = (missing: readonly string[]): string =>
    `Note: this package declares ${missing.length} ${missing.length === 1 ? "dependency" : "dependencies"} that ` +
    `${missing.length === 1 ? "is" : "are"} not installed (${missing.slice(0, NAMED_MISSING).join(", ")}${
        missing.length > NAMED_MISSING ? `, and ${missing.length - NAMED_MISSING} more` : ""
    }). Unresolved-import errors naming ${missing.length === 1 ? "it" : "those"} are the install being behind, not ` +
    "a mistake in this code — do not edit working source to satisfy one, and do not run an install; the daemon " +
    "installs them once this turn ends, so this package's own checks are available next turn, not this one.";

// PostToolUse on the native Edit/Write: type-check the touched file and feed compile errors back. Silent on
// clean files, non-TS files, and any failure — feedback must never break or stall an edit. Created once
// per turn (baseOptions), so `explained` scopes each standing notice to one telling per turn: the model needs
// a reason once, not stapled to every edit it makes for the rest of the conversation.
/* WHERE THE CHECK STANDS, which decides whether it can answer at all.
 *
 * An isolated turn names its files inside its own mount namespace (/work/...), which from the daemon — where
 * this hook body runs — is the MAIN checkout: the same path, a different file. There are two ways to be
 * truthful about that, and which one applies turns on whether the namespace was actually built.
 *
 * ANCHORED. The turn holds a namespace open, and its dependencies live ONLY in there: the worktree's own
 * node_modules are empty mount points on disk with the installed tree bound in over them. Translating the path
 * and checking from out here is therefore not a smaller version of the right answer, it is a different tree
 * with no dependencies in it — the state that produced 43,000 phantom "cannot find module 'vue'" errors in one
 * week of transcripts, and then, once the checker learned to refuse, near-total silence in their place. So the
 * service is placed INSIDE the turn instead (lsp/client.ts) and asked about the agent's own paths. It resolves
 * what the agent resolves, and it answers in the names the agent uses, which is also the end of reports that
 * quote a worktree path the agent must never reach for.
 *
 * UNANCHORED. No namespace could be built (no CAP_SYS_ADMIN), so the worktree stands on its own with its
 * dependency directories symlinked rather than mounted — reachable from here, and the translation IS the whole
 * of it. Only the reported names have to be mapped back for the agent to recognise its own files.
 */
export const editDiagnosticsHooks = (
    // The agent's own workspace root, in the agent's own naming.
    cwd: string,
    placement?: TurnPlacement,
    diag: DiagRunner = runResidentDiag,
    modules: ModulesProbe = modulesNear,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> => {
    const plan = placement?.plan;
    const anchor = placement?.anchor;
    // Both halves of the boundary, settled once: an anchored turn is asked in its own names and answers in
    // them, so nothing is translated in either direction.
    const service: ServiceLocation | undefined =
        anchor === undefined
            ? undefined
            : { reachableCwd: inWorktree(cwd, plan), enter: (command, args) => nsenterArgv(anchor.pid, anchor.cwd, command, args) };
    const checkedCwd = anchor === undefined ? inWorktree(cwd, plan) : cwd;
    const asAgentNames = anchor === undefined ? (file: string): string => fromWorktree(file, plan) : (file: string): string => file;
    // Per PACKAGE, not per turn: a turn that edits two packages has two different answers to give, and one
    // shared flag would silence whichever it reached second. The absent and refused cases key on "" — they are
    // the same fact, and there is only ever one of it worth saying.
    const explained = new Set<string>();
    // The last thing said about each file, so the same thing is not said twice running. Agents edit in bursts —
    // six edits to one file inside a minute re-check the same program and produce the same list — and one report
    // went out verbatim 2,923 times across the transcripts. Per file rather than global: two files failing the
    // same way are two facts.
    const lastReport = new Map<string, string>();
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
                        const target = anchor === undefined ? inWorktree(file, plan) : file;
                        // Anchored, this reads the MAIN checkout's installed tree — which is the right answer,
                        // because that tree is literally what the namespace binds in over the worktree's empty
                        // directories, so it is what the agent resolves against. The one thing it cannot see is
                        // a manifest the agent edited THIS turn: a dependency added and not yet installed reads
                        // as resolvable here, and its unresolved-import error arrives without the sentence
                        // explaining it. The errors are still right; only the reason for them goes unsaid.
                        const nearby = await modules(target);
                        if (nearby.kind === "absent") {
                            if (explained.has("")) {
                                return {};
                            }
                            explained.add("");
                            return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: UNAVAILABLE_NOTE } };
                        }
                        const output = await diag({ file: target, cwd: checkedCwd, service, named: asAgentNames });
                        // The daemon refusing is the same fact as an absent tree — no truthful diagnostics from
                        // here — and shares its once-per-turn telling, keyed on "".
                        if (output !== undefined && output.kind === "unavailable") {
                            if (explained.has("")) {
                                return {};
                            }
                            explained.add("");
                            return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: UNAVAILABLE_NOTE } };
                        }
                        // Keyed by the names themselves: an install that fixed half the list has changed what
                        // the model needs to know, and should be allowed to say so again.
                        const key = nearby.missing.join(",");
                        const stale = nearby.missing.length > 0 && !explained.has(key);
                        if (stale) {
                            explained.add(key);
                        }
                        const errors = output === undefined ? undefined : errorLines(output.lines);
                        if (errors === undefined) {
                            // Forgotten rather than remembered as empty: a file that came clean and breaks again
                            // later is news, and would be swallowed by a match against a stale entry.
                            lastReport.delete(file);
                            // Nothing to report about the edit itself — but a first sighting of a drifted tree
                            // is still worth the one sentence, because the next tool the model reaches for
                            // (a test, a lint) will fail on the same missing package.
                            return stale
                                ? { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: staleNote(nearby.missing) } }
                                : {};
                        }
                        const repeat = lastReport.get(file) === errors;
                        lastReport.set(file, errors);
                        // Silent only when there is nothing new in it at all: a first drift sentence is new even
                        // when the errors under it are not.
                        if (repeat && !stale) {
                            return {};
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
