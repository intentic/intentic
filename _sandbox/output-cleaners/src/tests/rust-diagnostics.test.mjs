import { describe, expect, it } from "bun:test";
import { filterOutput } from "../agent-output-filter.mjs";
import { foldRustDiagnostics } from "../rust-diagnostics.mjs";

// cargo's output as it prints it: a warning per call site of a lint, the same manifest warning per crate, errors among
// them. 2026-11-19, the shinobi-society audit: the same warning reached agents sixty times, and errors were grepped for.

const unused = (file, line) => [
    "warning: unused variable: `unused`",
    ` --> ${file}:${line}:41`,
    "  |",
    `${line} | pub fn add(a: i32, b: i32) -> i32 { let unused = 1; a + b }`,
    "  |                                         ^^^^^^ help: if this is intentional, prefix it with an underscore: `_unused`",
    "  |",
    "  = note: `#[warn(unused_variables)]` on by default",
    "",
];

const mismatch = [
    "error[E0308]: mismatched types",
    " --> src/main.rs:4:18",
    "  |",
    '4 |     let y: i32 = "a";',
    "  |            ---   ^^^ expected `i32`, found `&str`",
    "  |            |",
    "  |            expected due to this",
    "",
];

describe("foldRustDiagnostics", () => {
    it("folds a warning printed more than once to one line naming how often and where", () => {
        const lines = [
            "   Compiling ttc v0.1.0 (/tmp/ttc)",
            ...unused("src/lib.rs", 1),
            ...unused("src/lib.rs", 2),
            ...unused("src/other.rs", 9),
            ...unused("src/more.rs", 3),
            "warning: `ttc` (lib) generated 4 warnings",
            "    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.5s",
        ];
        expect(foldRustDiagnostics(lines)).toEqual([
            "(rustc output: each repeated warning folded to one line with its count and places)",
            "   Compiling ttc v0.1.0 (/tmp/ttc)",
            "warning: unused variable: `unused` (×4 at src/lib.rs:1:41, src/lib.rs:2:41, src/other.rs:9:41, +1 more)",
            "warning: `ttc` (lib) generated 4 warnings",
            "    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.5s",
        ]);
    });

    it("moves errors with their spans first, keeps a warning printed once whole, and counts a repeated spanless one", () => {
        const lines = [
            "warning: unused manifest key: package.foo",
            "   Compiling a v0.1.0 (/tmp/a)",
            "warning: unused manifest key: package.foo",
            ...unused("src/lib.rs", 1),
            ...mismatch,
            "error: could not compile `a` (bin \"a\") due to 1 previous error; 1 warning emitted",
        ];
        expect(foldRustDiagnostics(lines)).toEqual([
            "(rustc output: errors moved first; each repeated warning folded to one line with its count and places)",
            ...mismatch,
            "warning: unused manifest key: package.foo (×2)",
            "   Compiling a v0.1.0 (/tmp/a)",
            ...unused("src/lib.rs", 1),
            "error: could not compile `a` (bin \"a\") due to 1 previous error; 1 warning emitted",
        ]);
    });

    it("hands back exactly what came in when nothing repeats and errors already lead, or no diagnostic points at code", () => {
        const leading = [...mismatch, ...unused("src/lib.rs", 1)];
        expect(foldRustDiagnostics(leading)).toBe(leading);
        const plain = ["warning: something without a span", "warning: something without a span", "done"];
        expect(foldRustDiagnostics(plain)).toBe(plain);
    });
});

describe("the rustc stage in the filter", () => {
    const lines = [...unused("src/lib.rs", 1), ...unused("src/lib.rs", 2), ...mismatch, "error: could not compile `a`"];
    const raw = `${lines.join("\n")}\n`;

    it("folds a failed build too, ledgered as rustc", () => {
        const { out, stages } = filterOutput(raw, { command: "cargo build", exitCode: "101" });
        expect(out.startsWith("(rustc output: errors moved first;")).toBe(true);
        expect(out).toContain("warning: unused variable: `unused` (×2 at src/lib.rs:1:41, src/lib.rs:2:41)");
        expect(out).not.toContain("help: if this is intentional");
        expect(stages.find((stage) => stage.id === "rustc")?.saved).toBeGreaterThan(0);
    });

    it("is off when the spec turns rustc off", () => {
        const { out } = filterOutput(raw, { command: "cargo build", exitCode: "101", enabled: new Set(["dedup", "cap"]) });
        expect(out).toBe(raw);
    });
});
