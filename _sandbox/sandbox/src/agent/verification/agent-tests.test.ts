import { describe, expect, test } from "vitest";
import { measure, measureFile, measurePython, TEST_FILE, weakened } from "@intentic/constants/assertion-measure";
import { verifyTestsMessage } from "./agent-tests.js";

// The measure behind the ratchet (@intentic/constants/assertion-measure) is one copy shared by the push gate and this
// built-in; these are the shapes it must judge correctly.
const CORPUS = [
    // toEqual widened into toMatchObject plus a separate toContain fragment.
    `test("a", () => {
    expect(result).toEqual({ ok: true, message: "Reached Example, authenticated as ada." });
});`,
    `test("a", () => {
    expect(result).toMatchObject({ ok: true });
    expect(result.message).toContain("ada");
});`,
    // Templates count their static runs and not their \${…}; regexes count their source; escaped quotes stay inside.
    'it.each([1, 2])("n", (n) => { expect(text).toBe(`${n} of 12 files \\` still`); expect(text).toMatch(/9 of \\d+ files/); expect(s).toBe("it\\"s"); });',
    // Asymmetric matchers loosen the exact matcher they sit inside.
    `test("b", () => { expect(frame).toEqual({ id: expect.any(String), at: expect.closeTo(1, 2) }); });`,
    // Nested calls inside a matcher's argument list, multi-line.
    `test("c", async () => {
    expect(await run(fixture("x"), { deep: { keys: ["a", "b"] } })).toStrictEqual(
        expected(join("a", "b")),
    );
    expect(spy).toHaveBeenCalledWith("first", expect.objectContaining({ k: "v" }));
});`,
    // Neither exact nor loose: toThrow and toHaveProperty move no number.
    `test("d", () => { expect(() => f()).toThrow("boom"); expect(o).toHaveProperty("a.b", 1); });`,
    ``,
];

describe(`what counts as weaker`, () => {
    test(`the toEqual → toMatchObject + toContain move is a downgrade`, () => {
        const before = measure(CORPUS[0] ?? "");
        const after = measure(CORPUS[1] ?? "");
        // 38 is the length of the exact matcher's pinned string; 3 is "ada".
        expect(before).toEqual({ exact: 1, loose: 0, chars: 38, tests: 1 });
        expect(after).toEqual({ exact: 0, loose: 2, chars: 3, tests: 1 });
        expect(weakened(before, after)).toBe("downgrade");
    });

    // toEqual({}) is an exact matcher that pins nothing; trading it for a loose matcher that pins real values is not a
    // downgrade even though it looks like one.
    test(`a file that ends up pinning more text is not a downgrade`, () => {
        const before = measure(`test("a", () => { expect(out).toEqual({}); });`);
        const after = measure(`test("a", () => { expect(out).toMatchObject({ permissionDecision: "deny" }); });
test("b", () => { expect(out.logged).toMatchObject([{ outcome: "refused" }]); });`);
        expect(before).toEqual({ exact: 1, loose: 0, chars: 0, tests: 1 });
        // One exact matcher lost, two loose gained: the eleven pinned characters are why this isn't a weakening.
        expect(after).toEqual({ exact: 0, loose: 2, chars: 11, tests: 2 });
        expect(weakened(before, after)).toBeUndefined();
    });

    test(`asserted text cut past a quarter with the same tests is a narrowing`, () => {
        const before = measure(`test("x", () => { expect(t).toBe("Start your first agent"); });`);
        const after = measure(`test("x", () => { expect(t).toBe("first agent"); });`);
        expect(weakened(before, after)).toBe("narrowing");
    });

    test(`text that leaves with its tests is a deletion, not a narrowing`, () => {
        const before = measure(
            `test("x", () => { expect(t).toBe("Start your first agent"); });\ntest("y", () => { expect(u).toBe("gone"); });`,
        );
        const after = measure(`test("x", () => { expect(t).toBe("Start your first agent"); });`);
        expect(weakened(before, after)).toBeUndefined();
    });

    test(`a template's static runs are asserted text, and its \${…} is not`, () => {
        expect(measure('test("x", () => { expect(p).toBe(`${STATE_DIR}/config/safety.md`); });')).toEqual({
            exact: 1,
            loose: 0,
            chars: `/config/safety.md`.length,
            tests: 1,
        });
        // 40 characters: 21 from the template, 14 from the regex source, 5 from an escaped quote.
        expect(measure(CORPUS[2] ?? "")).toEqual({ exact: 2, loose: 1, chars: 40, tests: 1 });
    });

    test(`an apostrophe in a comment is prose, not a string that swallows the file`, () => {
        const commented = `// the owner's own copy
test("x", () => { expect(t).toBe("ada"); });
/* and the agent's, which is where the count used to run to */
test("y", () => { expect(u).toBe("bob"); });`;
        expect(measure(commented)).toEqual({ exact: 2, loose: 0, chars: 6, tests: 2 });
    });

    test(`stronger, or unchanged, is never a finding`, () => {
        const weak = measure(CORPUS[1] ?? "");
        const strong = measure(CORPUS[0] ?? "");
        expect(weakened(weak, strong)).toBeUndefined();
        expect(weakened(strong, strong)).toBeUndefined();
    });

    test(`the test-file shape is the one the whole daemon uses`, () => {
        expect(TEST_FILE.test("a.test.ts")).toBe(true);
        expect(TEST_FILE.test("a.integration.test.ts")).toBe(true);
        expect(TEST_FILE.test("a.spec.tsx")).toBe(true);
        expect(TEST_FILE.test("testing.ts")).toBe(false);
        expect(TEST_FILE.test("a.ts")).toBe(false);
        // pytest's own collection rule; fixtures and helpers beside tests use similar names but are not tests.
        expect(TEST_FILE.test("tests/test_api.py")).toBe(true);
        expect(TEST_FILE.test("api_test.py")).toBe(true);
        expect(TEST_FILE.test("conftest.py")).toBe(false);
        expect(TEST_FILE.test("tests/helpers.py")).toBe(false);
        expect(TEST_FILE.test("contest_python.py")).toBe(false);
    });
});

// The python arm of the same measure: python asserts via statements rather than matcher calls, so counting is separate
// code answering the same question.
describe(`the assertion measure, on python`, () => {
    const STRONG = `import pytest


def test_greeting():
    assert greet("ada") == "Hello, ada!"


def test_rows():
    assert rows(2) == [{"id": 1}, {"id": 2}]
`;
    // The same two tests after the weakening move: an equality becomes membership, then a bare truthiness check.
    const WEAK = `import pytest


def test_greeting():
    assert "ada" in greet("ada")


def test_rows():
    assert rows(2)
`;

    test(`an equality pins a value, a membership and a bare assert do not`, () => {
        expect(measurePython(STRONG)).toEqual({ exact: 2, loose: 0, chars: 18, tests: 2 });
        expect(measurePython(WEAK)).toEqual({ exact: 0, loose: 2, chars: 6, tests: 2 });
        expect(weakened(measurePython(STRONG), measurePython(WEAK))).toBe(`downgrade`);
        expect(weakened(measurePython(STRONG), measurePython(STRONG))).toBeUndefined();
    });

    test(`unittest's methods are read like matchers, and assertRaises like toThrow: as neither`, () => {
        const source = `class T(unittest.TestCase):
    def test_a(self):
        self.assertEqual(got, "abc")
        self.assertIn("a", got)
        with self.assertRaises(ValueError):
            f()
`;
        expect(measurePython(source)).toEqual({ exact: 1, loose: 1, chars: 4, tests: 1 });
    });

    test(`comments and docstrings are not assertions, whatever they contain`, () => {
        // The fixture's docstring holds an assert, an operator and quotes, none of them real assertions.
        const source = `# assert this == "not code"
def test_x():
    """A docstring with == and 'quotes' in it."""
    assert x == "ab"  # assert y in z
`;
        expect(measurePython(source)).toEqual({ exact: 1, loose: 0, chars: 2, tests: 1 });
    });

    test(`an assert spanning lines is measured whole, brackets and all`, () => {
        const source = `def test_big():
    assert result == {
        "a": 1,
        "b": "text",
    }
`;
        expect(measurePython(source)).toEqual({ exact: 1, loose: 0, chars: 6, tests: 1 });
    });

    test(`a file is measured as the language its name says, so the two versions cannot be read differently`, () => {
        expect(measureFile(STRONG, `tests/test_api.py`)).toEqual(measurePython(STRONG));
        expect(measure(STRONG)).toEqual({ exact: 0, loose: 0, chars: 0, tests: 0 });
        expect(measureFile(CORPUS[0] ?? ``, `a.test.ts`)).toEqual(measure(CORPUS[0] ?? ``));
    });
});

describe(`the verify-tests built-in`, () => {
    const STRONG = `test("x", () => { expect(t).toEqual({ a: 1, message: "Reached Example, authenticated as ada." }); });`;
    const WEAK = `test("x", () => { expect(t).toMatchObject({ a: 1 }); expect(t.message).toContain("ada"); });`;

    // Fake tree: HEAD and working-copy contents live only in these maps; git and `read` are the whole seam.
    const tree = (
        head: Readonly<Record<string, string>>,
        work: Readonly<Record<string, string>>,
        faults?: (file: string) => Promise<readonly string[] | undefined>,
    ) => ({
        root: `/repo`,
        changed: async () => Object.keys(work),
        git: async (_dir: string, args: readonly string[]) => {
            const path = (args[1] ?? "").replace(/^HEAD:/, "");
            const text = head[path];
            if (text === undefined) {
                throw new Error(`fatal: path '${path}' does not exist in 'HEAD'`);
            }
            return { stdout: text, stderr: "" };
        },
        read: async (path: string) => work[path.replace(/^\/repo\//, "")],
        ...(faults === undefined ? {} : { faults }),
    });

    test(`a touched test file whose assertions got weaker is named, with the numbers`, async () => {
        const message = await verifyTestsMessage(tree({ "src/a.test.ts": STRONG }, { "src/a.test.ts": WEAK }));
        expect(message).toContain("src/a.test.ts got weaker than at HEAD: downgrade (exact 1→0, loose 0→2");
        expect(message).toContain("not by widening the matcher");
        // Only the guidance for the kind found: nothing about the fault check when it had nothing to say.
        expect(message).not.toContain("passes without the change");
    });

    test(`a new test file, a stronger one and a non-test file are silent`, async () => {
        expect(await verifyTestsMessage(tree({}, { "src/new.test.ts": WEAK }))).toBeUndefined();
        expect(await verifyTestsMessage(tree({ "src/a.test.ts": WEAK }, { "src/a.test.ts": STRONG }))).toBeUndefined();
        expect(await verifyTestsMessage(tree({ "src/a.ts": STRONG }, { "src/a.ts": WEAK }))).toBeUndefined();
    });

    test(`a test that passes against the pre-turn code is named with the source that was restored`, async () => {
        const asked: string[] = [];
        const faults = async (file: string) => {
            asked.push(file);
            return file.endsWith("b.test.ts") ? ["src/b.ts"] : undefined;
        };
        const message = await verifyTestsMessage(
            tree({ "src/a.test.ts": STRONG, "src/b.test.ts": STRONG }, { "src/a.test.ts": STRONG, "src/b.test.ts": STRONG }, faults),
        );
        expect(asked).toEqual([`/repo/src/a.test.ts`, `/repo/src/b.test.ts`]);
        expect(message).toContain("src/b.test.ts passes against the code as it was before this turn (re-run with src/b.ts restored to HEAD)");
        expect(message).toContain("Two answers need no work");
        expect(message).not.toContain("widening the matcher");
    });

    test(`a fault check that throws is silence, not a finding`, async () => {
        const faults = async () => {
            throw new Error("vitest is not installed here");
        };
        expect(await verifyTestsMessage(tree({ "src/a.test.ts": STRONG }, { "src/a.test.ts": STRONG }, faults))).toBeUndefined();
    });

    test(`the fault check is asked about three files at most; the ratchet reads them all`, async () => {
        const files = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`src/t${i}.test.ts`, WEAK]));
        const asked: string[] = [];
        const faults = async (file: string) => {
            asked.push(file);
            return undefined;
        };
        const message = await verifyTestsMessage(tree(Object.fromEntries(Object.keys(files).map((k) => [k, STRONG])), files, faults));
        expect(asked).toHaveLength(3);
        expect(message?.match(/got weaker than at HEAD/g)).toHaveLength(6);
    });
});
