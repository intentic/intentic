import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import os from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import type { CheckPlacement } from "@intentic/lsp/client";
import { onPath } from "../../../platform/boot/on-path.js";
import type { DiagAnswer, DiagRequest } from "../agent-diagnostics.js";

/* THE PYTHON HALF OF THE POST-EDIT CHECK, the same seam the TypeScript one answers on (agent-diagnostics.ts's
 * DiagRunner), a different pair of tools behind it.
 *
 * WHY TWO TOOLS RATHER THAN ONE. The TypeScript side has a single answer to give because one compiler owns both
 * questions. Python splits them, and the split is the whole design here:
 *
 *   DOES IT PARSE, AND DOES IT NAME THINGS THAT EXIST — `ruff check --isolated --select E9,F821`. It needs no
 *   environment, no project config and no install, answers a file in milliseconds, and its two findings are the
 *   ones no reviewer would call a matter of taste: a file that does not parse, and a name that is not defined.
 *   `--isolated` is deliberate: this gate must mean the same thing in every repository and must not be
 *   switchable off by a `[tool.ruff]` table. Everything ELSE ruff can say is the project's own lint, a matter
 *   of that project's taste, and pushing it into a post-edit hook would steer the model into cleanup nobody
 *   asked for — the same reason the TypeScript side drops warnings and suggestions.
 *
 *   IS IT TYPE-CORRECT — pyright, and only where an environment exists to resolve imports against. This is the
 *   half that sees a wrong attribute, a bad call, a return that does not match its annotation.
 *
 * WHAT AN ABSENT ENVIRONMENT DOES, and why it is not silence. Without a `.venv` pyright resolves no third-party
 * import and reports every one of them as missing: confident, specific, and uninformative, which is the failure
 * agent-diagnostics.ts's node gate exists to prevent. But unlike the node case there is still a real answer to
 * be had — the file's OWN code type-checks against the bundled typeshed — so instead of checking nothing this
 * drops the import-resolution rules and keeps the rest, exactly as @intentic/lsp drops the module-shape errors a
 * `.vue` import produces and keeps every other diagnostic in the file real. The model is told once that the
 * imports went unresolved, so a quiet report is never read as a stronger claim than it is.
 *
 * WHAT IS NOT INSTALLED IS SAID, NEVER GUESSED AT. Both binaries ride the `python` feature pack
 * (image-packs/python.Dockerfile), so a core image has neither. Absent, this answers `unavailable` and the hook
 * says the edit went unchecked; a tool that is present but cannot be understood (a pyright whose JSON shape
 * moved) is the same answer. "Checked, and clean" is never said on the strength of a tool that did not run. */

export const PYTHON_EXTENSIONS = new Set([".py", ".pyi"]);

// Both tools are asked about ONE file and exit; nothing here stays resident. The bound is a hang bound, not a
// latency budget: ruff answers in milliseconds and pyright in a second or two on the projects this runs against.
const RUN_TIMEOUT_MS = 30_000;

// The environment a python project resolves its imports through, and the one name this looks for. `.venv` is
// what the setup recipes create (@intentic/workspace-setup) and what isolated turns mirror
// (@intentic/constants/mirror-roots), so it is the only spelling that is guaranteed to mean the same thing to
// the daemon and to the turn. A project using `venv/` or a global environment gets the no-environment answer,
// which is honest rather than clever.
const VENV = ".venv";

interface RunOutcome {
    readonly stdout: string;
    // Whether the tool ran to completion at all. A non-zero exit is an ANSWER here: both tools exit 1 when they
    // have findings. Only a spawn failure or a kill is "no answer".
    readonly answered: boolean;
}

/* One tool run, demoted and bounded, in the turn's own namespace when there is one. The placement dance is
 * @intentic/lsp's (checker.ts) and for the same reason: an anchored turn's files and its environment exist
 * inside its mount namespace, so the tool has to be entered into it and asked in that namespace's names.
 * `env -C` carries the working directory because the wrapper owns it once we are inside. */
const run = (command: string, args: readonly string[], cwd: string, placement: CheckPlacement | undefined): Promise<RunOutcome> =>
    new Promise((settle) => {
        const entered = placement?.enter("/usr/bin/env", ["-C", cwd, command, ...args]);
        const spawned =
            entered === undefined ? { command, args, options: { cwd } } : { command: entered.command, args: entered.args, options: {} };
        const child = spawn(spawned.command, [...spawned.args], { ...spawned.options, stdio: ["ignore", "pipe", "pipe"] });
        if (child.pid !== undefined) {
            try {
                os.setPriority(child.pid, 10);
            } catch {
                // EPERM/ESRCH: the check just runs undemoted.
            }
        }
        let stdout = "";
        child.stdout.on("data", (chunk: Buffer) => {
            stdout += String(chunk);
        });
        // Read and dropped: a tool's stderr is its own noise (a deprecation, a cache warning) and none of it is
        // a diagnostic. Left unread it fills the pipe buffer and the child blocks forever on a chatty run.
        child.stderr.resume();
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
        }, RUN_TIMEOUT_MS);
        child.on("error", () => {
            clearTimeout(timer);
            settle({ stdout, answered: false });
        });
        child.on("close", (_code, signal) => {
            clearTimeout(timer);
            settle({ stdout, answered: signal === null });
        });
    });

/* The nearest environment above a file, as the interpreter to hand pyright. The walk is `modulesNear`'s: up
 * from the file until something is found or the tree runs out. The INTERPRETER is what is checked rather than
 * the directory, because a `.venv` whose `bin/python` is gone (a half-deleted environment, a checkout of a
 * project that committed the directory by accident) resolves nothing, and treating it as an environment would
 * put us back to reporting every import as missing while claiming one was in use. */
export const interpreterNear = async (file: string): Promise<string | undefined> => {
    for (let dir = dirname(resolvePath(file)); ; ) {
        const interpreter = join(dir, VENV, "bin", "python");
        if (await access(interpreter, constants.X_OK).then(() => true, () => false)) {
            return interpreter;
        }
        const parent = dirname(dir);
        if (parent === dir) {
            return undefined;
        }
        dir = parent;
    }
};

/* `path:line:col: CODE message`, ruff's concise format, in both spellings it emits: a rule code (`F821 Undefined
 * name \`x\``) and a bare kind with a colon after it (`invalid-syntax: Expected \`)\`, found newline`). Anything
 * that does not match this shape is not a diagnostic — a summary line, a warning about the invocation — and is
 * dropped rather than reported as an error with no position. */
const RUFF_LINE = /^(?<file>.+?):(?<line>\d+):(?<column>\d+): (?<code>[A-Za-z0-9-]+):? (?<message>.*)$/;

// A file that does not PARSE: ruff reports these whatever is selected, and they are the one finding that makes
// asking a type-checker afterwards pointless.
const SYNTAX_CODE = "invalid-syntax";

export interface RuffFinding {
    // Kept beside the rendered line because one code decides what happens next: a file that does not parse ends
    // the check, and nothing downstream should have to re-parse the sentence to find that out.
    readonly code: string;
    readonly text: string;
}

/* `cwd` is not decoration: ruff prints every path RELATIVE to the directory it ran in, so a diagnostic about
 * `/work/app/main.py` arrives as `main.py` when the tool ran in `app`. Resolved back here, before `named` maps
 * it, because a bare filename is useless twice over — the model cannot tell which of a project's four
 * `models.py` it names, and the worktree-to-agent mapping has no path to match on. */
export const ruffFindings = (stdout: string, cwd: string, named: (file: string) => string): RuffFinding[] =>
    stdout
        .split("\n")
        .map((line) => RUFF_LINE.exec(line.trim())?.groups)
        .filter((groups): groups is Record<string, string> => groups !== undefined)
        .map((groups) => ({
            code: groups["code"]!,
            text: `${named(resolvePath(cwd, groups["file"]!))}:${groups["line"]!}:${groups["column"]!}: error ${groups["code"]!}: ${groups["message"]!}`,
        }));

/* Pyright's `--outputjson`, read defensively. The daemon parses a wire format it does not own, so the only
 * shapes it accepts are the ones it understands, and ANYTHING else — a bump that renamed the field, a run that
 * printed a banner, a kill mid-write — resolves to undefined, which the caller turns into "not checked". The
 * one thing this must never do is read an unrecognised payload as an empty diagnostic list, because that is
 * "checked, and clean" said about a check that did not happen.
 *
 * Positions are zero-based in the JSON and one-based everywhere a human or a model reads them, hence the +1.
 * `rule` is absent on syntax and internal errors, which is why the code falls back to the severity. */
interface PyrightPosition {
    readonly line?: unknown;
    readonly character?: unknown;
}

interface PyrightDiagnostic {
    readonly severity?: unknown;
    readonly rule?: unknown;
    readonly file?: unknown;
    readonly message?: unknown;
    readonly range?: { readonly start?: PyrightPosition };
}

// Zero-based in the JSON, one-based everywhere a model or a person reads a position. A payload missing the
// range at all still gets a position rather than a broken line: the claim is the part that matters.
const positionOf = (start: PyrightPosition | undefined): string =>
    `${typeof start?.line === "number" ? start.line + 1 : 1}:${typeof start?.character === "number" ? start.character + 1 : 1}`;

// Which diagnostics the model is shown: errors only, minus the import-resolution rules when there was no
// environment for pyright to resolve against, where they say nothing except that we knew there was no environment.
const shown = (severity: unknown, rule: string | undefined, keepUnresolvedImports: boolean): boolean =>
    severity === "error" && (keepUnresolvedImports || rule === undefined || !UNRESOLVED_IMPORT_RULES.has(rule));

// One diagnostic as the model reads it, or undefined for one it is not shown.
const pyrightLine = (entry: PyrightDiagnostic, named: (file: string) => string, keepUnresolvedImports: boolean): string | undefined => {
    const rule = typeof entry.rule === "string" ? entry.rule : undefined;
    if (!shown(entry.severity, rule, keepUnresolvedImports)) {
        return undefined;
    }
    const file = typeof entry.file === "string" ? named(entry.file) : "";
    // First line only: pyright writes multi-line explanations under a message, and the position plus the claim
    // is what the model acts on.
    return `${file}:${positionOf(entry.range?.start)}: error ${rule ?? "error"}: ${String(entry.message ?? "").split("\n")[0]}`;
};

export const pyrightErrors = (stdout: string, named: (file: string) => string, keepUnresolvedImports: boolean): string[] | undefined => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(stdout);
    } catch {
        return undefined;
    }
    const diagnostics = (parsed as { generalDiagnostics?: unknown }).generalDiagnostics;
    if (!Array.isArray(diagnostics)) {
        return undefined;
    }
    return (diagnostics as PyrightDiagnostic[])
        .map((entry) => pyrightLine(entry, named, keepUnresolvedImports))
        .filter((line): line is string => line !== undefined);
};

// What pyright says when it has no environment to resolve against, and the only diagnostics dropped when the
// environment is missing. Everything else it reports about the file is about the file.
const UNRESOLVED_IMPORT_RULES = new Set(["reportMissingImports", "reportMissingModuleSource"]);

// Said once per turn, alongside real findings rather than instead of them: the syntax and undefined-name gate
// still ran and its answer stands. Named as a limit of this check, never as an instruction to install anything —
// an install from inside a turn lands in a scratch layer that dies with the conversation.
const NO_ENVIRONMENT_NOTE =
    "Note: no `.venv` was found above this file, so imports were not resolved and import-resolution errors were left out rather " +
    "than reported. Everything above is real; a type error that depends on a third-party package's types may be missing.";

const NO_CHECKER_NOTE =
    "Note: this sandbox has no `pyright`, so the type half of this check did not run. The file was still checked for syntax " +
    "errors and undefined names.";

export const PYTHON_UNAVAILABLE_NOTE =
    "Python diagnostics are unavailable for this edit: neither `ruff` nor `pyright` answered in this sandbox, so nothing " +
    "checked this file. That is a limit of this check, not a verdict on the code: run the project's own tests or linter when " +
    "you need this file verified.";

// The environment-free gate. Undefined ⇒ ruff is not here or did not finish, which is a different fact from
// "nothing to report" and is carried as one all the way to the answer.
const gateFindings = async (
    file: string,
    cwd: string,
    placement: CheckPlacement | undefined,
    named: (file: string) => string,
): Promise<RuffFinding[] | undefined> => {
    if (!(await onPath("ruff"))) {
        return undefined;
    }
    const args = ["check", "--isolated", "--no-cache", "--quiet", "--select", "E9,F821", "--output-format", "concise", file];
    const outcome = await run("ruff", args, cwd, placement);
    return outcome.answered ? ruffFindings(outcome.stdout, cwd, named) : undefined;
};

// The type half. Undefined ⇒ pyright is not here, did not finish, or answered in a shape this cannot read.
const typeFindings = async (
    file: string,
    cwd: string,
    interpreter: string | undefined,
    placement: CheckPlacement | undefined,
    named: (file: string) => string,
): Promise<string[] | undefined> => {
    if (!(await onPath("pyright"))) {
        return undefined;
    }
    const args = ["--outputjson", ...(interpreter === undefined ? [] : ["--pythonpath", interpreter]), file];
    const outcome = await run("pyright", args, cwd, placement);
    return outcome.answered ? pyrightErrors(outcome.stdout, named, interpreter !== undefined) : undefined;
};

/* The two halves assembled. Both silent for lack of running is `unavailable`; either one having run makes the
 * result a real check, with a note where what ran was narrower than it looks. */
const assembled = (gate: readonly RuffFinding[] | undefined, types: readonly string[] | undefined, note: string | undefined): DiagAnswer =>
    gate === undefined && types === undefined
        ? { kind: "unavailable" }
        : {
              kind: "checked",
              lines: [...(gate ?? []).map((finding) => finding.text), ...(types ?? [])],
              ...(note === undefined ? {} : { note }),
          };

/* One python file, checked as far as this sandbox can check it. `unavailable` means nothing could be said, and
 * that is never conflated with a clean file. */
export const runPythonDiag = async ({ file, placement, named }: DiagRequest): Promise<DiagAnswer> => {
    const interpreter = await interpreterNear(file);
    // Where the tools run: the project root the environment implies, else the file's own directory. It is what
    // pyright resolves a `pyrightconfig.json` or a `pyproject.toml` against.
    const cwd = interpreter === undefined ? dirname(resolvePath(file)) : dirname(dirname(dirname(interpreter)));
    const gate = await gateFindings(file, cwd, placement, named);
    // A file that does not parse is the end of the story: pyright would report the same failure more slowly,
    // and every other question about the file is unanswerable until it parses.
    if (gate?.some((finding) => finding.code === SYNTAX_CODE) === true) {
        return assembled(gate, undefined, undefined);
    }
    const types = await typeFindings(file, cwd, interpreter, placement, named);
    return assembled(gate, types, noteFor(gate, types, interpreter));
};

// Which qualification the answer carries, if any: the type half absent entirely, or present but blind to
// imports. Nothing is said when both halves ran with an environment behind them.
const noteFor = (
    gate: readonly RuffFinding[] | undefined,
    types: readonly string[] | undefined,
    interpreter: string | undefined,
): string | undefined => {
    if (types === undefined) {
        return gate === undefined ? undefined : NO_CHECKER_NOTE;
    }
    return interpreter === undefined ? NO_ENVIRONMENT_NOTE : undefined;
};
