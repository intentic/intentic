import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import os from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import type { CheckPlacement } from "@intentic/lsp/client";
import { onPath } from "../../../platform/boot/on-path.js";
import type { DiagAnswer, DiagRequest } from "../agent-diagnostics.js";

// Python half of the same post-edit-check seam (DiagRunner), a different pair of tools. ruff answers parsing and
// undefined names, needing no environment; pyright answers type-correctness, only with a `.venv` to resolve imports,
// and stays quiet on the question both share (GATE_RULES). No environment drops only import-resolution rules; neither
// tool present answers `unavailable`, never clean.

export const PYTHON_EXTENSIONS = new Set([".py", ".pyi"]);

// Both tools are asked about one file and exit; the bound is a hang bound, not a latency budget.
const RUN_TIMEOUT_MS = 30_000;

// The venv spelling the daemon and an isolated turn agree on; anything else is treated as no environment.
const VENV = ".venv";

interface RunOutcome {
    readonly stdout: string;
    // Whether the tool ran to completion; a non-zero exit is itself an answer, only a spawn failure or kill is not.
    readonly answered: boolean;
}

// One tool run, demoted and bounded, entered into the turn's own namespace when there is one, the same placement dance
// as @intentic/lsp's checker.ts.
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
        // Read and dropped: stderr is noise, and left unread it fills the pipe buffer and blocks a chatty run forever.
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

// The nearest environment above a file, walked the way modulesNear does. Checks the interpreter, not just the
// directory, since a `.venv` whose `bin/python` is gone resolves nothing.
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

// ruff's concise format, path:line:col: CODE message, both spellings; anything else is dropped, not a finding.
const RUFF_LINE = /^(?<file>.+?):(?<line>\d+):(?<column>\d+): (?<code>[A-Za-z0-9-]+):? (?<message>.*)$/;

// A file that does not PARSE: ruff reports these whatever is selected, and they are the one finding that makes
// asking a type-checker afterwards pointless.
const SYNTAX_CODE = "invalid-syntax";

export interface RuffFinding {
    // Kept beside the rendered line since a file that fails to parse ends the check right there.
    readonly code: string;
    readonly text: string;
}

// `cwd` isn't decoration: ruff prints paths relative to where it ran, so they're resolved back here before `named` maps
// them onto the agent's own names.
export const ruffFindings = (stdout: string, cwd: string, named: (file: string) => string): RuffFinding[] =>
    stdout
        .split("\n")
        .map((line) => RUFF_LINE.exec(line.trim())?.groups)
        .filter((groups): groups is Record<string, string> => groups !== undefined)
        .map((groups) => ({
            code: groups["code"]!,
            text: `${named(resolvePath(cwd, groups["file"]!))}:${groups["line"]!}:${groups["column"]!}: error ${groups["code"]!}: ${groups["message"]!}`,
        }));

// Reads pyright's `--outputjson` defensively: any shape it doesn't recognize (a renamed field, a banner, a kill
// mid-write) becomes undefined, read as not checked, never as an empty clean list. Positions are zero-based in the
// JSON, one-based everywhere else.
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

// Zero-based in the JSON, one-based everywhere a model or person reads a position; a missing range still gets a
// position rather than a broken line.
const positionOf = (start: PyrightPosition | undefined): string =>
    `${typeof start?.line === "number" ? start.line + 1 : 1}:${typeof start?.character === "number" ? start.character + 1 : 1}`;

// Errors only, minus rules this run has decided pyright must stay quiet on; a diagnostic with no rule (syntax,
// internal) is always shown.
const shown = (severity: unknown, rule: string | undefined, dropped: ReadonlySet<string>): boolean =>
    severity === "error" && (rule === undefined || !dropped.has(rule));

// One diagnostic as the model reads it, or undefined for one it is not shown.
const pyrightLine = (entry: PyrightDiagnostic, named: (file: string) => string, dropped: ReadonlySet<string>): string | undefined => {
    const rule = typeof entry.rule === "string" ? entry.rule : undefined;
    if (!shown(entry.severity, rule, dropped)) {
        return undefined;
    }
    const file = typeof entry.file === "string" ? named(entry.file) : "";
    // First line only: the position plus the claim is what the model acts on, not pyright's multi-line explanation.
    return `${file}:${positionOf(entry.range?.start)}: error ${rule ?? "error"}: ${String(entry.message ?? "").split("\n")[0]}`;
};

export const pyrightErrors = (stdout: string, named: (file: string) => string, dropped: ReadonlySet<string>): string[] | undefined => {
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
        .map((entry) => pyrightLine(entry, named, dropped))
        .filter((line): line is string => line !== undefined);
};

// The only diagnostics dropped when there's no environment; everything else reported is about the file itself.
const UNRESOLVED_IMPORT_RULES = ["reportMissingImports", "reportMissingModuleSource"];

// The one question both tools answer (undefined name); ruff owns it, so pyright's copy drops once ruff has run.
const GATE_RULES = ["reportUndefinedVariable"];

// Which rules pyright is not shown on: no environment to resolve imports, or a gate that already answered the same
// question. Assembled by the caller, who knows whether ruff ran and an interpreter was found.
export const droppedRules = ({ environment, gated }: { environment: boolean; gated: boolean }): ReadonlySet<string> =>
    new Set([...(environment ? [] : UNRESOLVED_IMPORT_RULES), ...(gated ? GATE_RULES : [])]);

// Said once per turn, alongside findings, never as an install instruction: an install here dies with the turn.
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

// The environment-free gate; undefined means ruff isn't here or didn't finish, a different fact from nothing to report.
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

// The type half; undefined means pyright isn't here, didn't finish, or answered unreadably. `gated` is whether ruff
// already answered, so pyright doesn't repeat it.
const typeFindings = async (
    file: string,
    cwd: string,
    interpreter: string | undefined,
    placement: CheckPlacement | undefined,
    named: (file: string) => string,
    gated: boolean,
): Promise<string[] | undefined> => {
    if (!(await onPath("pyright"))) {
        return undefined;
    }
    const args = ["--outputjson", ...(interpreter === undefined ? [] : ["--pythonpath", interpreter]), file];
    const outcome = await run("pyright", args, cwd, placement);
    return outcome.answered ? pyrightErrors(outcome.stdout, named, droppedRules({ environment: interpreter !== undefined, gated })) : undefined;
};

// The two halves assembled: both silent is `unavailable`; either running makes it a real check, noted when narrower
// than it looks.
const assembled = (gate: readonly RuffFinding[] | undefined, types: readonly string[] | undefined, note: string | undefined): DiagAnswer =>
    gate === undefined && types === undefined
        ? { kind: "unavailable" }
        : {
              kind: "checked",
              lines: [...(gate ?? []).map((finding) => finding.text), ...(types ?? [])],
              ...(note === undefined ? {} : { note }),
          };

// One python file, checked as far as this sandbox can; `unavailable` means nothing could be said, never conflated with
// a clean file.
export const runPythonDiag = async ({ file, placement, named }: DiagRequest): Promise<DiagAnswer> => {
    const interpreter = await interpreterNear(file);
    // Where the tools run: the project root the environment implies, else the file's own directory. It is what
    // pyright resolves a `pyrightconfig.json` or a `pyproject.toml` against.
    const cwd = interpreter === undefined ? dirname(resolvePath(file)) : dirname(dirname(dirname(interpreter)));
    const gate = await gateFindings(file, cwd, placement, named);
    // A file that fails to parse ends the story: every other question about it is unanswerable until it does.
    if (gate?.some((finding) => finding.code === SYNTAX_CODE) === true) {
        return assembled(gate, undefined, undefined);
    }
    const types = await typeFindings(file, cwd, interpreter, placement, named, gate !== undefined);
    return assembled(gate, types, noteFor(gate, types, interpreter));
};

// Which qualification the answer carries: the type half absent, or present but blind to imports; nothing when both ran
// clean.
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
