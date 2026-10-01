import { editDistance, renderVerify, type VerifyLookup, verifyReferences } from "./check.js";
import { extractReferences } from "./extract.js";

// One file, src/a.ts, 200 lines: `alpha` defined at 10 (body 10-20), `beta` used at 150 only, `gamma` nowhere in it.
const lookup: VerifyLookup = {
    resolvePath: (raw) => {
        if (raw === "src/a.ts" || raw === "/elsewhere/checkout/src/a.ts") {
            return { status: "found", path: "src/a.ts" };
        }
        return raw === "index.ts" ? { status: "ambiguous" } : { status: "missing", suggestion: "src/a.ts" };
    },
    lineCount: () => 200,
    occurrences: (_path, name) => ({ alpha: [10, 18], beta: [150] })[name] ?? [],
    enclosingSpan: (_path, line) => (line >= 10 && line <= 20 ? { start: 10, end: 20 } : undefined),
    definitions: (name) => (name === "alpha" ? [{ path: "src/a.ts", line: 10 }] : []),
    mentioned: (name) => ["beta", "gamma"].includes(name),
    closestName: (name) => (name === "alphaa" ? "alpha" : undefined),
};

const check = (text: string) => verifyReferences(extractReferences(text), lookup);

test("a grounded answer has no issues and counts what it checked", () => {
    const report = check("`src/a.ts:12` — `alpha()` builds it; `index.ts` is real.\nElsewhere `beta()` is used.");
    expect(report.issues).toEqual([]);
    expect(report).toMatchObject({ files: 2, anchors: 1, names: 2 });
});

test("missing files carry a suggestion, reported once however often cited", () => {
    const report = check("`src/b.ts:3` and again `src/b.ts`");
    expect(report.issues).toEqual([{ line: 1, kind: "missing-file", ref: "src/b.ts", message: "no such file in this workspace; closest: src/a.ts" }]);
});

test("an anchor past the end of its file", () => {
    expect(check("`src/a.ts:400`").issues).toEqual([{ line: 1, kind: "past-end", ref: "src/a.ts:400", message: "the file has 200 lines" }]);
});

test("drift: a name the file holds far from the cited line; its enclosing body or the tolerance band is near enough", () => {
    // Plain words count here: `alpha` in backticks beside an anchor says where the anchor should point.
    expect(check("`src/a.ts:100` — `alpha` does it").issues).toEqual([
        { line: 1, kind: "drifted-anchor", ref: "src/a.ts:100", message: "`alpha` is at src/a.ts:10, not near line 100" },
    ]);
    // 140 is within 15 of 150; 12 sits inside alpha's 10-20 body even though `alpha` also appears at 18.
    expect(check("`src/a.ts:140` — `beta` runs").issues).toEqual([]);
    expect(check("`src/a.ts:12` — `alpha` starts").issues).toEqual([]);
    // A name the cited file does not contain may describe code elsewhere: no judgement.
    expect(check("`src/a.ts:12` — calls `gamma`").issues).toEqual([]);
    // Two anchors into one file on a line: which name describes which is a guess, so neither is judged.
    expect(check("`src/a.ts:100` and `src/a.ts:110` — `alpha` does it").issues).toEqual([]);
    // One near name clears the anchor: `beta` (far, at 150) is a passing mention beside its subject `alpha`.
    expect(check("`src/a.ts:12` — `alpha` sets up what `beta` reads").issues).toEqual([]);
});

test("a name neither defined nor written anywhere is unknown, with the closest real one", () => {
    expect(check("`alphaa()` and `zeta_func`").issues).toEqual([
        { line: 1, kind: "unknown-name", ref: "alphaa()", message: "defined nowhere and written nowhere in this workspace; closest: alpha" },
        { line: 1, kind: "unknown-name", ref: "zeta_func", message: "defined nowhere and written nowhere in this workspace" },
    ]);
});

test("render: capsule line first, one aligned row per issue; grounded and empty answers say so", () => {
    expect(renderVerify(check("`src/a.ts:12` `alpha()`"), "answer.md")).toBe(
        "iq verify: answer.md · 1 files, 1 anchors, 1 names checked · grounded\n",
    );
    expect(renderVerify(check("no references at all"), "stdin")).toContain("nothing to check");
    expect(renderVerify(check("`src/b.ts`\n\n\n\n\n\n\n\n\n`zeta_func`"), "answer.md")).toBe(
        [
            "iq verify: answer.md · 1 files, 0 anchors, 1 names checked · 2 issues",
            "L1   missing file    src/b.ts — no such file in this workspace; closest: src/a.ts",
            "L10  unknown name    zeta_func — defined nowhere and written nowhere in this workspace",
            "",
        ].join("\n"),
    );
});

test("editDistance stops early past its limit", () => {
    expect(editDistance("sign_cookie", "sign_cookies", 3)).toBe(1);
    expect(editDistance("abc", "xyzxyz", 2)).toBe(3);
});
