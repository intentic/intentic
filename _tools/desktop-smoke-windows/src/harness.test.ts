import { expect, test } from "vitest";
import { createHarness, type Harness } from "./harness.js";

/* The polling loop's deadline arithmetic, asserted without spending real seconds — which is the whole reason
 * `now` and `sleep` are injected. A real timer would make these tests slow AND hide the case that matters:
 * whether the predicate is given its chance before the deadline is consulted. */

const collected = (): { harness: Harness; out: string[]; err: string[]; tick: (ms: number) => void } => {
    const out: string[] = [];
    const err: string[] = [];
    let clock = 0;
    const harness = createHarness({
        write: (line) => out.push(line),
        writeError: (line) => err.push(line),
        now: () => clock,
        // Time only moves when the loop sleeps, so a test controls exactly how many attempts happen.
        sleep: async (ms) => {
            clock += ms;
        },
    });
    return { harness, out, err, tick: (ms) => (clock += ms) };
};

test("a predicate that already holds passes on the first attempt", async () => {
    const { harness, out } = collected();
    expect(await harness.untilTrue(30, `it is true`, () => true)).toBe(true);
    expect(out.join(`\n`)).toContain(`ok   it is true`);
    expect(harness.failures()).toBe(0);
});

test("a zero-second deadline still gets one attempt — the caller asked for a fact, not a delay", async () => {
    const { harness } = collected();
    expect(await harness.untilTrue(0, `it is true`, () => true)).toBe(true);
    expect(harness.failures()).toBe(0);
});

test("a predicate that never holds fails once, naming what it waited", async () => {
    const { harness, err } = collected();
    expect(await harness.untilTrue(2, `the window opened`, () => false)).toBe(false);
    expect(harness.failures()).toBe(1);
    expect(err.join(`\n`)).toContain(`the window opened (waited 2s)`);
});

test("a predicate that becomes true before the deadline passes", async () => {
    const { harness } = collected();
    let attempts = 0;
    expect(
        await harness.untilTrue(10, `it settles`, () => {
            attempts += 1;
            return attempts >= 3;
        }),
    ).toBe(true);
    expect(attempts).toBe(3);
    expect(harness.failures()).toBe(0);
});

test("a throwing probe counts as 'no', not as a crash", async () => {
    // Every probe here shells out; "the command failed" and "the command said no" are the same answer to the
    // question being asked, and a tier must not die because docker was briefly unreachable.
    const { harness } = collected();
    expect(
        await harness.untilTrue(1, `docker answers`, () => {
            throw new Error(`ENOENT`);
        }),
    ).toBe(false);
    expect(harness.failures()).toBe(1);
});

test("a failure does not stop the run, and the count is the exit code's only input", async () => {
    const { harness } = collected();
    harness.pass(`one`);
    harness.fail(`two`);
    harness.pass(`three`);
    harness.fail(`four`);
    expect(harness.failures()).toBe(2);
    expect(harness.report(`the tier`)).toBe(1);
});

test("a clean run reports zero", () => {
    const { harness, out } = collected();
    harness.pass(`one`);
    expect(harness.report(`everything worked`)).toBe(0);
    expect(out.join(`\n`)).toContain(`everything worked`);
});

test("detail is indented under the assertion it explains, every line of it", () => {
    const { harness, err } = collected();
    harness.fail(`it broke`, `line one\nline two`);
    expect(err.join(`\n`)).toContain(`       line one\n       line two`);
});
