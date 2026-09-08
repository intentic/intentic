import { extname } from "node:path";
import { type CheckPlacement, diagnose } from "@intentic/lsp/client";
import type { HookCallbackMatcher, HookEvent, HookInput, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { fromWorktree, inWorktree, nsenterArgv, type TurnPlacement } from "../../agents/worktrees/isolation.js";
import { modulesNear, type NearbyModules } from "../../workspace/deps/dependency-drift.js";
import type { ShellEditTracker } from "../tools/agent-shell-edits.js";
import { EDIT_TOOLS, editedPath } from "../../rules/edit-tools.js";
import { PYTHON_EXTENSIONS, PYTHON_UNAVAILABLE_NOTE, runPythonDiag } from "./python/python-diagnostics.js";

// After every Edit/Write (and, via a tracker, Bash) the touched file is checked and compile errors ride back as
// additionalContext; `.py` files go through a different runner behind the identical contract. Gated on the package's
// dependencies being installed: an absent tree checks nothing, a partial one still checks with the missing names said
// alongside the real errors.

// TypeScript-checked extensions; a python file goes to the other checker, anything else isn't checked here.
const CHECKED_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

// Bounds the feedback so a cascading break can't flood the transcript: errors only, first lines, capped chars.
const MAX_LINES = 20;
const MAX_CHARS = 4_000;
// How many files one shell command's diagnostics cover, capped so a hundred-file rewrite is one compiler run.
const SHELL_FILES = 20;

// Asks the compiler about one file. undefined means no project to check; `unavailable` means the checker itself refused
// rather than report from a half-loaded program.
export type DiagAnswer =
    | {
          readonly kind: "checked";
          readonly lines: readonly string[];
          // What the model needs to read the lines correctly, when only half a checker ran; TypeScript never sets this.
          readonly note?: string;
      }
    | { readonly kind: "unavailable" };

// One file's check and where it is asked from: `placement` enters the compiler into the view the paths are named for
// (undefined if that's this process's own); `named` maps a reported file back to the agent's name for it.
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

// Keeps only error lines the model must act on; warnings are dropped, and a file with none yields undefined. Severity
// is matched, not the code that follows it, since python's codes aren't TS's.
const errorLines = (lines: readonly string[]): string | undefined => {
    const errors = lines.filter((line) => line.includes(": error ")).slice(0, MAX_LINES);
    return errors.length === 0 ? undefined : errors.join("\n").slice(0, MAX_CHARS);
};

// What's wrong with this file's installed tree, if anything; injectable so tests need no fixture tree.
export type ModulesProbe = (file: string) => Promise<NearbyModules>;

// How many missing names are shown; enough to recognise the dependency just added.
const NAMED_MISSING = 3;

// States only what's knowable from here: an absent tree, an unreachable one, a checker refusal share this note.
const UNAVAILABLE_NOTE =
    "Type diagnostics are unavailable for this edit: the type-checker cannot resolve this package's dependencies " +
    "from where it runs, so it would report every import as broken whatever the edit did. That is a limit of this " +
    "check, not a verdict on your tools or on the code: run the package's own type-check, lint or tests when you " +
    "need this file verified.";

// Said alongside the diagnostics, not instead of them: a tree missing one package still checks everything else
// correctly. Tells the model not to install, since an isolated turn's install would die with the turn; the daemon
// reconciles it once the turn ends.
const staleNote = (missing: readonly string[]): string =>
    `Note: this package declares ${missing.length} ${missing.length === 1 ? "dependency" : "dependencies"} that ` +
    `${missing.length === 1 ? "is" : "are"} not installed (${missing.slice(0, NAMED_MISSING).join(", ")}${
        missing.length > NAMED_MISSING ? `, and ${missing.length - NAMED_MISSING} more` : ""
    }). Unresolved-import errors naming ${missing.length === 1 ? "it" : "those"} are the install being behind, not ` +
    "a mistake in this code: do not edit working source to satisfy one, and do not run an install; the daemon " +
    "installs them once this turn ends, so this package's own checks are available next turn, not this one.";

// PostToolUse on native Edit/Write and, when a tracker is given, on Bash: files a shell command changed are reviewed
// exactly like an edit, in the agent's own names. Silent on clean files, unchecked languages and any failure; each
// standing notice is scoped to once per turn.
// An isolated turn names its files inside its own mount namespace, which from the daemon is the main checkout, the same
// path but a different file. Anchored, the compiler enters the turn's namespace and resolves the agent's own paths;
// unanchored, the worktree stands on its own and only the reported names need mapping back.
// A second reader of the same edit, beside the type check: what a `file.edited` rule's command says about the file.
// Same signature as `review`, so a reader added later needs nothing but a place in the list; undefined means nothing to
// say.
export type EditReviewer = (file: string, how: string) => Promise<string | undefined>;

// Where the checks stand, settled once per turn and handed to every checker: asked in whose names, entered into whose
// namespace, reported back in whose names, so no checker mixes its own reading of anchor with the turn's.
const checkBoundary = (
    placement: TurnPlacement | undefined,
): {
    readonly checkPlacement: CheckPlacement | undefined;
    readonly asAgentNames: (file: string) => string;
    readonly inTurn: (file: string) => string;
} => {
    const plan = placement?.plan;
    const anchor = placement?.anchor;
    if (anchor === undefined) {
        return {
            checkPlacement: undefined,
            asAgentNames: (file) => fromWorktree(file, plan),
            inTurn: (file) => inWorktree(file, plan),
        };
    }
    // Anchored: the turn is asked in its own names and answers in them, so nothing is translated either way.
    return {
        checkPlacement: { enter: (command, args) => nsenterArgv(anchor.pid, anchor.cwd, command, args) },
        asAgentNames: (file) => file,
        inTurn: (file) => file,
    };
};

export const editDiagnosticsHooks = (
    placement?: TurnPlacement,
    diag: DiagRunner = runNativeDiag,
    modules: ModulesProbe = modulesNear,
    shell?: ShellEditTracker,
    reviewers: readonly EditReviewer[] = [],
    pythonDiag: DiagRunner = runPythonDiag,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> => {
    const { checkPlacement, asAgentNames, inTurn } = checkBoundary(placement);
    // Per PACKAGE, not per turn: a turn that edits two packages has two different answers to give, and one
    // shared flag would silence whichever it reached second. A standing note is keyed by its own text, so each
    // distinct sentence is said once and two different ones do not silence each other.
    const explained = new Set<string>();
    // Last report per file: suppressed per file, not globally, since two files failing the same way are two facts.
    const lastReport = new Map<string, string>();
    // Says a standing note the first time it applies, keyed on the sentence itself: an absent tree and a refused
    // checker share one sentence and one telling.
    const oncePerTurn = (note: string): string | undefined => {
        if (explained.has(note)) {
            return undefined;
        }
        explained.add(note);
        return note;
    };
    // Whether a drifted tree is news, keyed by the missing names themselves: an install that changes the list may say
    // so again.
    const firstSighting = (missing: readonly string[]): boolean => {
        const key = missing.join(",");
        if (missing.length === 0 || explained.has(key)) {
            return false;
        }
        explained.add(key);
        return true;
    };
    // One file's review, in words the model reads, or undefined for nothing to say. `how` names what changed the file
    // ("this edit" or "this command").
    const review = async (file: string, how: string): Promise<string | undefined> => {
        const target = inTurn(file);
        // Anchored, this reads the MAIN checkout's installed tree, which is the right answer,
        // because that tree is literally what the namespace binds in over the worktree's empty
        // directories, so it is what the agent resolves against. The one thing it cannot see is
        // a manifest the agent edited THIS turn: a dependency added and not yet installed reads
        // as resolvable here, and its unresolved-import error arrives without the sentence
        // explaining it. The errors are still right; only the reason for them goes unsaid.
        const nearby = await modules(target);
        if (nearby.kind === "absent") {
            return oncePerTurn(UNAVAILABLE_NOTE);
        }
        const output = await diag({ file: target, placement: checkPlacement, named: asAgentNames });
        if (output?.kind === "unavailable") {
            return oncePerTurn(UNAVAILABLE_NOTE);
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
        return report("TypeScript", file, how, errors, stale ? staleNote(nearby.missing) : undefined);
    };
    // Structurally the TypeScript review with a different checker: no installed-tree probe (python-diagnostics.ts gates
    // itself), and a note may qualify the findings, said once, even alongside a clean result.
    const reviewPython = async (file: string, how: string): Promise<string | undefined> => {
        const output = await pythonDiag({ file: inTurn(file), placement: checkPlacement, named: asAgentNames });
        if (output === undefined || output.kind === "unavailable") {
            return oncePerTurn(PYTHON_UNAVAILABLE_NOTE);
        }
        const qualifier = output.note === undefined ? undefined : oncePerTurn(output.note);
        const errors = errorLines(output.lines);
        if (errors === undefined) {
            lastReport.delete(file);
            return qualifier;
        }
        return report("Python", file, how, errors, qualifier);
    };
    // The errors, unless they repeat this file's last report with nothing new around them: a new `extra` sentence still
    // counts as news even when the errors under it don't.
    const report = (language: string, file: string, how: string, errors: string, extra: string | undefined): string | undefined => {
        const repeat = lastReport.get(file) === errors;
        lastReport.set(file, errors);
        if (repeat && extra === undefined) {
            return undefined;
        }
        return (
            `${language} diagnostics for ${file} after ${how}:\n${errors}\n` +
            `${extra === undefined ? "" : `${extra}\n`}Fix the errors ${how} introduced before finishing.`
        );
    };
    const said = (context: string | undefined): HookJSONOutput =>
        context === undefined ? {} : { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context } };
    // Everything to say about one file after one edit: the type/lint check when the extension matches, then every other
    // reviewer, each gating itself.
    const everything = async (file: string, how: string): Promise<string | undefined> => {
        const notes: string[] = [];
        const extension = extname(file);
        const checked = CHECKED_EXTENSIONS.has(extension) ? review : PYTHON_EXTENSIONS.has(extension) ? reviewPython : undefined;
        if (checked !== undefined) {
            const context = await checked(file, how);
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
