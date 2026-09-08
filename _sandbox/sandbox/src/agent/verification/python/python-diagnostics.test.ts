import { HISTORY_ROOT, WORKSPACE_ROOT } from "@intentic/constants";
import { expect, test } from "vitest";
import { droppedRules, pyrightErrors, ruffFindings } from "./python-diagnostics.js";

// Two parsers between this daemon and a tool it does not own: a payload neither can understand must read as unchecked,
// never as clean. Ruff's fixtures are its real output (`ruff check --isolated --select E9,F821 --output-format
// concise`), covering both spellings it emits.

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
    // Both halves of the path gap: ruff names files where it ran; an unanchored checker sits in the worktree.
    const findings = ruffFindings("deep/main.py:2:12: F821 Undefined name `x`", `${HISTORY_ROOT}/worktrees/c1/app`, (file) =>
        file.replace(`${HISTORY_ROOT}/worktrees/c1`, WORKSPACE_ROOT),
    );

    expect(findings.map((finding) => finding.text)).toEqual(["/work/app/deep/main.py:2:12: error F821: Undefined name `x`"]);
});

// One payload covering every case: error shown, warning not, position moved zero-based to one-based.
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

// The two facts that decide what pyright may say: an environment behind it, a gate in front of it.
const WHOLE = droppedRules({ environment: true, gated: false });

test("with an environment, every error is reported, warnings are not, and positions become one-based", () => {
    expect(pyrightErrors(PYRIGHT_JSON, asIs, WHOLE)).toEqual([
        '/work/app/main.py:12:5: error reportAttributeAccessIssue: Cannot access attribute "titel" for class "str"',
        '/work/app/main.py:3:8: error reportMissingImports: Import "httpx" could not be resolved',
    ]);
});

test("without an environment the unresolved-import errors are dropped and the rest still stands", () => {
    // Dropped rather than reported: with no `.venv` they only confirm what is already known, not real errors.
    expect(pyrightErrors(PYRIGHT_JSON, asIs, droppedRules({ environment: false, gated: false }))).toEqual([
        '/work/app/main.py:12:5: error reportAttributeAccessIssue: Cannot access attribute "titel" for class "str"',
    ]);
});

// The one finding both tools produce: ruff's F821 and pyright's reportUndefinedVariable, the same missing name.
const UNDEFINED_NAME_JSON = JSON.stringify({
    generalDiagnostics: [
        {
            file: `${WORKSPACE_ROOT}/app/main.py`,
            severity: "error",
            message: '"missing_helper" is not defined',
            range: { start: { line: 1, character: 11 }, end: { line: 1, character: 25 } },
            rule: "reportUndefinedVariable",
        },
    ],
});

test("what the ruff gate already said, pyright does not say again — and says when the gate did not run", () => {
    // With ruff's answer in hand the model sees one line, not two; with no ruff, pyright reports it instead.
    expect(pyrightErrors(UNDEFINED_NAME_JSON, asIs, droppedRules({ environment: true, gated: true }))).toEqual([]);
    expect(pyrightErrors(UNDEFINED_NAME_JSON, asIs, droppedRules({ environment: true, gated: false }))).toEqual([
        '/work/app/main.py:2:12: error reportUndefinedVariable: "missing_helper" is not defined',
    ]);
});

// The gate drops its own rule and nothing else: a `dropped` set that grew to swallow the type half's findings too would
// read exactly like a clean file.
test("dropping the gate's rule takes nothing else with it", () => {
    const both = JSON.stringify({
        generalDiagnostics: [
            {
                file: `${WORKSPACE_ROOT}/app/main.py`,
                severity: "error",
                message: '"missing_helper" is not defined',
                range: { start: { line: 1, character: 11 }, end: { line: 1, character: 25 } },
                rule: "reportUndefinedVariable",
            },
            {
                file: `${WORKSPACE_ROOT}/app/main.py`,
                severity: "error",
                message: 'Cannot access attribute "titel" for class "str"',
                range: { start: { line: 4, character: 4 }, end: { line: 4, character: 9 } },
                rule: "reportAttributeAccessIssue",
            },
        ],
    });
    expect(pyrightErrors(both, asIs, droppedRules({ environment: true, gated: true }))).toEqual([
        '/work/app/main.py:5:5: error reportAttributeAccessIssue: Cannot access attribute "titel" for class "str"',
    ]);
});

test("a payload this cannot read is not a clean file", () => {
    // Every unreadable payload answers "could not read": unchecked, not a clean bill of health.
    expect(pyrightErrors("", asIs, WHOLE)).toBeUndefined();
    expect(pyrightErrors("Traceback (most recent call last):", asIs, WHOLE)).toBeUndefined();
    expect(pyrightErrors(JSON.stringify({ version: "1.1.413", summary: {} }), asIs, WHOLE)).toBeUndefined();
    expect(pyrightErrors('{"generalDiagnostics": {"file": "x"}}', asIs, WHOLE)).toBeUndefined();
    // A run that really found nothing is a different answer, and it is the empty list.
    expect(pyrightErrors(JSON.stringify({ generalDiagnostics: [] }), asIs, WHOLE)).toEqual([]);
});

test("a diagnostic missing the parts it should have is still reported, with what it has", () => {
    // Pyright omits `rule` on some errors and may omit range entirely; reporting at 1:1 beats dropping the error.
    expect(pyrightErrors(JSON.stringify({ generalDiagnostics: [{ file: "/work/a.py", severity: "error", message: "Expected expression" }] }), asIs, WHOLE)).toEqual([
        "/work/a.py:1:1: error error: Expected expression",
    ]);
});
