import { extname } from "node:path";
import { type CheckPlacement, diagnose } from "@intentic/lsp/client";
import type { HookCallbackMatcher, HookEvent, HookInput, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { fromWorktree, inWorktree, nsenterArgv, type TurnPlacement } from "../agents/isolation.js";
import { modulesNear, type NearbyModules } from "../workspace/dependency-drift.js";
import type { ShellEditTracker } from "./agent-shell-edits.js";
import { EDIT_TOOLS, editedPath } from "../rules/edit-tools.js";

/* Post-edit diagnostics feedback, the VSCode Claude Code loop, reproduced daemon-side: after every native
 * Edit/Write the touched file is type-checked and any COMPILE ERRORS ride back to the model as additionalContext,
 * so it self-corrects inside the same turn instead of leaving broken code for the user to find. VS Code gets this
 * for free because its language server is already resident and has already computed the markers; the sandbox has
 * no editor, so it asks the native TypeScript compiler instead, a fresh whole-project run per question
 * (@intentic/lsp), which answers a package-sized check in 0.1–2s and holds nothing in memory between edits.
 * There used to be a resident JS-compiler daemon here to make per-edit checks affordable; the native compiler
 * made cold checks as fast as the daemon's warm answers, and the ~1 GB per workspace view it stayed resident to
 * protect is simply given back.
 *
 * The whole loop is GATED on the dependencies actually being installed. Without node_modules the compiler
 * cannot resolve a single import, not even `node:path`, whose types ship in @types/node, so it reports
 * hundreds of errors on lines the edit never touched, and every one of them is an artifact of the missing
 * install. That is worse than silence: it is confident, specific, wrong feedback, and the model spends real
 * reasoning deciding to distrust it. So when the modules aren't there we say exactly that, once, and check
 * nothing. See workspace-setup.ts for the readiness model this mirrors.
 *
 * A PARTIALLY installed tree is the same failure wearing a disguise, and it is the one this workspace actually
 * produces. node_modules exists, so the old gate opened; the dependency the agent added two edits ago is not in
 * it, so every import of it reports TS2307, a real diagnostic code, on the real line, naming a real package,
 * and completely uninformative about what is wrong. The model's cheapest reading of that is "I got the import
 * wrong", and what follows is an edit to correct source. So the gate now asks the question it always meant:
 * not "is there a node_modules" but "can this file's package resolve what it declares" (dependency-drift.ts).
 * Diagnostics still run, the rest of the file's errors are real and worth having, with the cause named
 * alongside them so an unresolved import is read as the install being behind rather than as a mistake. */

// The checker is TypeScript/JavaScript only, other files are never checked.
const CHECKED_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

// Bound the feedback so a cascading break can't flood the transcript: errors only, first lines, capped chars.
const MAX_LINES = 20;
const MAX_CHARS = 4_000;
// How many files one shell command's diagnostics cover. A script that rewrote a hundred files gets the first
// twenty checked, one compiler run per package either way, and a transcript that is still readable.
const SHELL_FILES = 20;

// Ask the compiler about one file. Undefined means "no answer to be had", no TypeScript project above the
// file, which must stay distinguishable from "checked, and clean". `unavailable` is the checker itself
// refusing: it reached the file's project and could not load it well enough to vouch for anything, so it
// checked nothing rather than answer from a half-loaded program. The refusal reason names checker-side paths
// the agent may have no window onto, so it is not carried here, the notice below says what is true from here.
export type DiagAnswer = { readonly kind: "checked"; readonly lines: readonly string[] } | { readonly kind: "unavailable" };

// One file's check, and everything about WHERE it is asked. `placement` enters the compiler into the view the
// paths are named for (undefined when that is this process's own), and `named` turns a file the checker
// reported back into the name the agent uses for it, identity when the two stand in the same view.
export interface DiagRequest {
    readonly file: string;
    readonly placement: CheckPlacement | undefined;
    readonly named: (file: string) => string;
}

export type DiagRunner = (request: DiagRequest) => Promise<DiagAnswer | undefined>;

const runNativeDiag: DiagRunner = async ({ file, placement, named }) => {
    const report = await diagnose({ files: [file], ...(placement !== undefined ? { placement } : {}) });
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

// Compress to the error lines the model must act on. Warnings/suggestions are dropped, they'd steer the model
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
 * One is a tree nobody has installed (dependency-drift.ts). One is an install this process cannot SEE, an
 * isolated turn's node_modules is mounted inside the turn's namespace, so a checker outside finds an empty
 * directory where the agent finds 34 packages. And one is the type-checker itself refusing: the project's
 * config chain or type foundations would not load from where it stands, so it declined to answer at all rather
 * than report the phantom errors a half-loaded program produces (@intentic/lsp). They are one fact for this
 * hook's purposes, no truthful diagnostics from here, and completely different facts for the agent, which is
 * why the sentence names no cause and prescribes no install: told "dependencies are not installed" an agent
 * whose own type-check passes either distrusts working tooling or goes looking for an install that would land
 * in an overlay and die with the conversation.
 *
 * So it says only what is known from here, and points at the check that CAN answer, the package's own. */
const UNAVAILABLE_NOTE =
    "Type diagnostics are unavailable for this edit: the type-checker cannot resolve this package's dependencies " +
    "from where it runs, so it would report every import as broken whatever the edit did. That is a limit of this " +
    "check, not a verdict on your tools or on the code: run the package's own type-check, lint or tests when you " +
    "need this file verified.";

/* Said ALONGSIDE the diagnostics rather than instead of them, which is the difference between this and the
 * absent case. A tree missing one package still type-checks everything else correctly, so suppressing the whole
 * report would throw away real errors the edit introduced; what the model needs is the one sentence that stops
 * it misreading the errors about THOSE names. It is also told not to install, because in an isolated turn the
 * install would land in an overlay that dies with the conversation (agents/isolation.ts), the daemon reconciles
 * the real tree instead, and it does so once this turn ENDS. Stated that way for the reason workspace-setup.ts
 * sets out at length: the reconciler defers while a turn is live, so an agent promised relief "once the
 * workspace is idle" is promised something its own working prevents, with no signal for when it arrives. */
const staleNote = (missing: readonly string[]): string =>
    `Note: this package declares ${missing.length} ${missing.length === 1 ? "dependency" : "dependencies"} that ` +
    `${missing.length === 1 ? "is" : "are"} not installed (${missing.slice(0, NAMED_MISSING).join(", ")}${
        missing.length > NAMED_MISSING ? `, and ${missing.length - NAMED_MISSING} more` : ""
    }). Unresolved-import errors naming ${missing.length === 1 ? "it" : "those"} are the install being behind, not ` +
    "a mistake in this code: do not edit working source to satisfy one, and do not run an install; the daemon " +
    "installs them once this turn ends, so this package's own checks are available next turn, not this one.";

/* PostToolUse on the native Edit/Write, AND on Bash: type-check the touched files and feed compile errors back.
 * Silent on clean files, non-TS files, and any failure, feedback must never break or stall an edit. Created once
 * per turn (baseOptions), so `explained` scopes each standing notice to one telling per turn: the model needs
 * a reason once, not stapled to every edit it makes for the rest of the conversation.
 *
 * THE SHELL IS AN EDITOR TOO. A model told to prefer `sed -i`, a heredoc or a script (the harness's own
 * bypass-mode instructions say exactly that) writes files this hook never heard of when it listened to the edit
 * tools alone, and gets no diagnostics for them: how a test file that did not compile reached main with every
 * per-edit check green. So when a tracker is supplied (agent-shell-edits.ts), the tree is snapshotted before each
 * Bash command and read after it, and every TypeScript file the command changed is reviewed exactly as an Edit
 * would have been, in the agent's own names. */
/* WHERE THE CHECK STANDS, which decides whether it can answer at all.
 *
 * An isolated turn names its files inside its own mount namespace (/work/...), which from the daemon, where
 * this hook body runs, is the MAIN checkout: the same path, a different file. There are two ways to be
 * truthful about that, and which one applies turns on whether the namespace was actually built.
 *
 * ANCHORED. The turn holds a namespace open, and its dependencies live ONLY in there: the worktree's own
 * node_modules are empty mount points on disk with the installed tree bound in over them. Translating the path
 * and checking from out here is therefore not a smaller version of the right answer, it is a different tree
 * with no dependencies in it, the state that produced 43,000 phantom "cannot find module 'vue'" errors in one
 * week of transcripts, and then, once the checker learned to refuse, near-total silence in their place. So the
 * compiler is ENTERED into the turn's namespace instead (lsp/checker.ts) and asked about the agent's own
 * paths. It resolves what the agent resolves, and it answers in the names the agent uses, which is also the
 * end of reports that quote a worktree path the agent must never reach for.
 *
 * UNANCHORED. No namespace could be built (no CAP_SYS_ADMIN), so the worktree stands on its own with its
 * dependency directories symlinked rather than mounted, reachable from here, and the translation IS the whole
 * of it. Only the reported names have to be mapped back for the agent to recognise its own files.
 */
/* A second reader of the same edit, beside the type check: what a `file.edited` rule's command says about
 * the file (rules/file-edited.ts). Same signature as `review` below, so the two are run the same way in both
 * places an edit is heard, after an edit tool and after a shell command that changed the file, and a reader
 * added later needs nothing but a place in the list. Undefined ⇒ nothing to say, the common answer. */
export type EditReviewer = (file: string, how: string) => Promise<string | undefined>;

export const editDiagnosticsHooks = (
    placement?: TurnPlacement,
    diag: DiagRunner = runNativeDiag,
    modules: ModulesProbe = modulesNear,
    shell?: ShellEditTracker,
    reviewers: readonly EditReviewer[] = [],
): Partial<Record<HookEvent, HookCallbackMatcher[]>> => {
    const plan = placement?.plan;
    const anchor = placement?.anchor;
    // Both halves of the boundary, settled once: an anchored turn is asked in its own names and answers in
    // them, so nothing is translated in either direction.
    const checkPlacement: CheckPlacement | undefined =
        anchor === undefined ? undefined : { enter: (command, args) => nsenterArgv(anchor.pid, anchor.cwd, command, args) };
    const asAgentNames = anchor === undefined ? (file: string): string => fromWorktree(file, plan) : (file: string): string => file;
    // Per PACKAGE, not per turn: a turn that edits two packages has two different answers to give, and one
    // shared flag would silence whichever it reached second. The absent and refused cases key on "", they are
    // the same fact, and there is only ever one of it worth saying.
    const explained = new Set<string>();
    // The last thing said about each file, so the same thing is not said twice running. Agents edit in bursts,
    // six edits to one file inside a minute re-check the same program and produce the same list, and one report
    // went out verbatim 2,923 times across the transcripts. Per file rather than global: two files failing the
    // same way are two facts.
    const lastReport = new Map<string, string>();
    // The absent-tree and refused-checker cases are one fact, no truthful diagnostics from here, said once per
    // turn and keyed on "".
    const unavailableOnce = (): string | undefined => {
        if (explained.has("")) {
            return undefined;
        }
        explained.add("");
        return UNAVAILABLE_NOTE;
    };
    // Whether a drifted tree is news: keyed by the missing names themselves, so an install that fixed half the
    // list has changed what the model needs to know and is allowed to say so again.
    const firstSighting = (missing: readonly string[]): boolean => {
        const key = missing.join(",");
        if (missing.length === 0 || explained.has(key)) {
            return false;
        }
        explained.add(key);
        return true;
    };
    /* One file's review, in the words the model reads, or undefined for nothing to say. `how` names what just
     * changed the file, "this edit" or "this command", because the sentence is about what the model just did. */
    const review = async (file: string, how: string): Promise<string | undefined> => {
        const target = anchor === undefined ? inWorktree(file, plan) : file;
        // Anchored, this reads the MAIN checkout's installed tree, which is the right answer,
        // because that tree is literally what the namespace binds in over the worktree's empty
        // directories, so it is what the agent resolves against. The one thing it cannot see is
        // a manifest the agent edited THIS turn: a dependency added and not yet installed reads
        // as resolvable here, and its unresolved-import error arrives without the sentence
        // explaining it. The errors are still right; only the reason for them goes unsaid.
        const nearby = await modules(target);
        if (nearby.kind === "absent") {
            return unavailableOnce();
        }
        const output = await diag({ file: target, placement: checkPlacement, named: asAgentNames });
        if (output?.kind === "unavailable") {
            return unavailableOnce();
        }
        const stale = firstSighting(nearby.missing);
        const errors = output === undefined ? undefined : errorLines(output.lines);
        if (errors === undefined) {
            // Forgotten rather than remembered as empty: a file that came clean and breaks again
            // later is news, and would be swallowed by a match against a stale entry.
            lastReport.delete(file);
            // Nothing to report about the edit itself, but a first sighting of a drifted tree
            // is still worth the one sentence, because the next tool the model reaches for
            // (a test, a lint) will fail on the same missing package.
            return stale ? staleNote(nearby.missing) : undefined;
        }
        return report(file, how, errors, stale ? nearby.missing : undefined);
    };
    // The errors themselves, unless they are this file's last report repeated with nothing new around them: a
    // first drift sentence is new even when the errors under it are not.
    const report = (file: string, how: string, errors: string, missing: readonly string[] | undefined): string | undefined => {
        const repeat = lastReport.get(file) === errors;
        lastReport.set(file, errors);
        if (repeat && missing === undefined) {
            return undefined;
        }
        return (
            `TypeScript diagnostics for ${file} after ${how}:\n${errors}\n` +
            `${missing === undefined ? "" : `${staleNote(missing)}\n`}Fix the errors ${how} introduced before finishing.`
        );
    };
    const said = (context: string | undefined): HookJSONOutput =>
        context === undefined ? {} : { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context } };
    /* Everything there is to say about one file after one edit: the type check, where the file is one the
     * checker reads, then every other reader. The type check is gated on the extension because the checker is
     * TypeScript's; a reviewer is asked about every file and gates itself (a rule's `when.paths`). */
    const everything = async (file: string, how: string): Promise<string | undefined> => {
        const notes: string[] = [];
        if (CHECKED_EXTENSIONS.has(extname(file))) {
            const context = await review(file, how);
            if (context !== undefined) {
                notes.push(context);
            }
        }
        for (const reviewer of reviewers) {
            const context = await reviewer(file, how).catch(() => undefined);
            if (context !== undefined) {
                notes.push(context);
            }
        }
        return notes.length === 0 ? undefined : notes.join("\n\n");
    };
    return {
        ...(shell === undefined
            ? {}
            : {
                  PreToolUse: [
                      {
                          matcher: "Bash",
                          hooks: [
                              async (input) => {
                                  if (input.hook_event_name === "PreToolUse") {
                                      await shell.before();
                                  }
                                  return {};
                              },
                          ],
                      },
                  ],
              }),
        PostToolUse: [
            {
                matcher: EDIT_TOOLS,
                hooks: [
                    async (input) => {
                        if (input.hook_event_name !== "PostToolUse") {
                            return {};
                        }
                        const file = editedPath(input.tool_input);
                        if (file === undefined) {
                            return {};
                        }
                        return said(await everything(file, "this edit"));
                    },
                ],
            },
            ...(shell === undefined
                ? []
                : [
                      {
                          matcher: "Bash",
                          hooks: [
                              async (input: HookInput): Promise<HookJSONOutput> => {
                                  if (input.hook_event_name !== "PostToolUse") {
                                      return {};
                                  }
                                  const edits = (await shell.changed()).slice(0, SHELL_FILES);
                                  const notes: string[] = [];
                                  for (const edit of edits) {
                                      const context = await everything(edit.path, "this command");
                                      if (context !== undefined) {
                                          notes.push(context);
                                      }
                                  }
                                  return said(notes.length === 0 ? undefined : notes.join("\n\n"));
                              },
                          ],
                      },
                  ]),
        ],
    };
};
