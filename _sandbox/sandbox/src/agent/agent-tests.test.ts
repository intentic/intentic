import { describe, expect, test } from "vitest";
import { measure, weakened } from "@intentic/constants/assertion-measure";
import { TEST_FILE, verifyTestsMessage } from "./agent-tests.js";

/* The measure behind the ratchet (@intentic/constants/assertion-measure) is one copy, read by the push gate and by
 * the built-in below; these are the judgments it has to make, on the shapes the 08-31 sweep produced. */
const CORPUS = [
    // The shape the 08-31 sweep produced: exact object equality widened to a partial match plus a fragment.
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
        // 38 is the length of the one string the exact matcher pins; 3 is "ada".
        expect(before).toEqual({ exact: 1, loose: 0, chars: 38, tests: 1 });
        expect(after).toEqual({ exact: 0, loose: 2, chars: 3, tests: 1 });
        expect(weakened(before, after)).toBe("downgrade");
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

    /* WHAT COUNTS AS ASSERTED TEXT, on the literal shapes a test file actually writes: a template composed from
     * a constant (which this repository requires of every path, see _tools/checks/path-literals.mjs), a regex,
     * an escaped quote. The template is the one worth stating: `${STATE_DIR}/config/safety.md` asserts the
     * seventeen characters of path around the interpolation, and reading the whole literal as computed made
     * every path assertion in the repository read as an assertion about nothing. */
    test(`a template's static runs are asserted text, and its \${…} is not`, () => {
        expect(measure('test("x", () => { expect(p).toBe(`${STATE_DIR}/config/safety.md`); });')).toEqual({
            exact: 1,
            loose: 0,
            chars: `/config/safety.md`.length,
            tests: 1,
        });
        // 40 characters: 21 of template around `${n}`, 14 of regex source, 5 of a string holding an escaped quote.
        expect(measure(CORPUS[2] ?? "")).toEqual({ exact: 2, loose: 1, chars: 40, tests: 1 });
    });

    /* AND WHAT IS NOT ASSERTED TEXT: the prose around the assertion. These files are commented line by line and
     * the prose says "the owner's", so a walker that read that apostrophe as an opening quote ran past the `)`
     * it was measuring and counted to the end of the file. Editing a comment then moved the number, and landed a
     * narrowing on a file whose assertions nobody had touched. */
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
    });
});

describe(`the verify-tests built-in`, () => {
    const STRONG = `test("x", () => { expect(t).toEqual({ a: 1, message: "Reached Example, authenticated as ada." }); });`;
    const WEAK = `test("x", () => { expect(t).toMatchObject({ a: 1 }); expect(t.message).toContain("ada"); });`;

    // A tree with one file at HEAD and one in the working copy, and nothing on disk: git and the reader are the
    // whole seam, so the test says exactly which version each side sees.
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
