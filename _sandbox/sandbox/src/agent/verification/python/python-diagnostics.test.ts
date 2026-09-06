import { HISTORY_ROOT, WORKSPACE_ROOT } from "@intentic/constants";
import { expect, test } from "vitest";
import { pyrightErrors, ruffFindings } from "./python-diagnostics.js";

/* THE TWO PARSERS BETWEEN THIS DAEMON AND A TOOL IT DOES NOT OWN. Both read a format someone else versions, and
 * both have the same duty at the edge: a payload that cannot be understood is "not checked", never "checked and
 * clean". A silent misparse here does not look like a bug — it looks like a python file that had nothing wrong
 * with it, on every edit, forever.
 *
 * The ruff fixtures are its real output, taken from running `ruff check --isolated --select E9,F821
 * --output-format concise` over files with those faults in them; both spellings it emits are here because they
 * differ in punctuation and one regex has to read both. */

const asIs = (file: string): string => file;

test("ruff's two diagnostic spellings both parse, and the prose around them does not", () => {
    const findings = ruffFindings(
        [
            "main.py:1:7: invalid-syntax: Expected a parameter or the end of the parameter list",
            "main.py:2:12: F821 Undefined name `undefined_name`",
            "Found 2 errors.",
            "",
        ].join("\n"),
        `${WORKSPACE_ROOT}/app`,
        asIs,
    );

    expect(findings).toEqual([
        { code: "invalid-syntax", text: "/work/app/main.py:1:7: error invalid-syntax: Expected a parameter or the end of the parameter list" },
        { code: "F821", text: "/work/app/main.py:2:12: error F821: Undefined name `undefined_name`" },
    ]);
});

test("a relative path is resolved against the run's own directory before it is reported in the agent's names", () => {
    // Both halves of what stands between a tool's idea of a path and the agent's: ruff names the file relative
    // to where it ran, and an unanchored turn's checker stands in the worktree while the agent stands in /work.
    const findings = ruffFindings("deep/main.py:2:12: F821 Undefined name `x`", `${HISTORY_ROOT}/worktrees/c1/app`, (file) =>
        file.replace(`${HISTORY_ROOT}/worktrees/c1`, WORKSPACE_ROOT),
    );

    expect(findings.map((finding) => finding.text)).toEqual(["/work/app/deep/main.py:2:12: error F821: Undefined name `x`"]);
});

// One payload, every case the reader has to tell apart: an error is shown, a warning is not, and the position
// is the JSON's zero-based one moved to the one-based one everything else in the report uses.
const PYRIGHT_JSON = JSON.stringify({
    version: "1.1.413",
    generalDiagnostics: [
        {
            file: `${WORKSPACE_ROOT}/app/main.py`,
            severity: "error",
            message: 'Cannot access attribute "titel" for class "str"\n  Attribute "titel" is unknown',
            range: { start: { line: 11, character: 4 }, end: { line: 11, character: 9 } },
            rule: "reportAttributeAccessIssue",
        },
        {
            file: `${WORKSPACE_ROOT}/app/main.py`,
            severity: "warning",
            message: 'Import "os" is not accessed',
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 9 } },
        },
        {
            file: `${WORKSPACE_ROOT}/app/main.py`,
            severity: "error",
            message: 'Import "httpx" could not be resolved',
            range: { start: { line: 2, character: 7 }, end: { line: 2, character: 12 } },
            rule: "reportMissingImports",
        },
    ],
    summary: { filesAnalyzed: 1, errorCount: 2, warningCount: 1 },
});

test("with an environment, every error is reported, warnings are not, and positions become one-based", () => {
    expect(pyrightErrors(PYRIGHT_JSON, asIs, true)).toEqual([
        '/work/app/main.py:12:5: error reportAttributeAccessIssue: Cannot access attribute "titel" for class "str"',
        '/work/app/main.py:3:8: error reportMissingImports: Import "httpx" could not be resolved',
    ]);
});

test("without an environment the unresolved-import errors are dropped and the rest still stands", () => {
    // Dropped rather than reported, because with no `.venv` they say only that we already knew there was none —
    // and dropping them is what lets the file's own errors be reported instead of a wall of missing imports.
    expect(pyrightErrors(PYRIGHT_JSON, asIs, false)).toEqual([
        '/work/app/main.py:12:5: error reportAttributeAccessIssue: Cannot access attribute "titel" for class "str"',
    ]);
});

test("a payload this cannot read is not a clean file", () => {
    // Each of these is a real way the run can end: a tool that printed something else, a version that renamed
    // the field, a process killed mid-write. Every one must answer "could not read" so the caller says the file
    // went unchecked; an empty array here would be a clean bill of health nobody issued.
    expect(pyrightErrors("", asIs, true)).toBeUndefined();
    expect(pyrightErrors("Traceback (most recent call last):", asIs, true)).toBeUndefined();
    expect(pyrightErrors(JSON.stringify({ version: "1.1.413", summary: {} }), asIs, true)).toBeUndefined();
    expect(pyrightErrors('{"generalDiagnostics": {"file": "x"}}', asIs, true)).toBeUndefined();
    // A run that really found nothing is a different answer, and it is the empty list.
    expect(pyrightErrors(JSON.stringify({ generalDiagnostics: [] }), asIs, true)).toEqual([]);
});

test("a diagnostic missing the parts it should have is still reported, with what it has", () => {
    // Pyright omits `rule` on syntax and internal errors, and a payload with no range at all has been seen from
    // a crashed analysis. Reporting the claim at 1:1 beats dropping an error because its position was missing.
    expect(pyrightErrors(JSON.stringify({ generalDiagnostics: [{ file: "/work/a.py", severity: "error", message: "Expected expression" }] }), asIs, true)).toEqual([
        "/work/a.py:1:1: error error: Expected expression",
    ]);
});
