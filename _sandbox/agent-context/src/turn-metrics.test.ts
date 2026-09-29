import { toolCategoryOf } from "./tool-calls.js";
import { createTurnMetrics, type ToolCallFacts } from "./turn-metrics.js";

// Any absolute root: listings are judged by depth below it, and nothing here touches the disk.
const ROOT = "/repo";

// The four readings are all claims about order (same calls, different sequence, is a different turn), so fixtures are
// sequences and results are computed, not snapshotted.

const call = (name: string, over: { target?: string; paths?: string[] } = {}): ToolCallFacts => ({
    name,
    // Uses the production category mapping, so a call scores here exactly as in a real turn.
    category: toolCategoryOf(name),
    ...(over.target === undefined ? {} : { target: over.target }),
    ...(over.paths === undefined ? {} : { locations: over.paths.map((path) => ({ path })) }),
});

const readingOf = (calls: readonly ToolCallFacts[], edited: readonly string[] = []) => {
    const metrics = createTurnMetrics(ROOT);
    for (const each of calls) {
        metrics.call(each);
    }
    return { ...metrics.reading(edited), calls: metrics.calls() };
};

test("orientation is counted up to the first file, and listings are counted apart from searches", () => {
    const reading = readingOf([
        call("Bash", { target: "ls" }),
        call("Bash", { target: "rg needle" }),
        call("Read", { paths: ["src/a.ts"] }),
        // Past the first file, still a search, but no longer orientation or a listing.
        call("Bash", { target: "rg other" }),
        call("Bash", { target: "ls" }),
    ]);

    expect(reading).toMatchObject({ calls: 5, searchCalls: 4, openingSearches: 2, openingListings: 1 });
});

test("a turn that goes straight to work has no orientation at all", () => {
    expect(readingOf([call("Read", { paths: ["src/a.ts"] }), call("Edit", { paths: ["src/a.ts"] })])).toMatchObject({
        searchCalls: 0,
        openingSearches: 0,
        openingListings: 0,
    });
});

// The edited file is only known at the end, which is why this reading is computed off a ledger rather than tracked in a
// running counter.
test("calls before the target count the walk up to the file the turn went on to edit", () => {
    const calls = [
        call("Bash", { target: "ls" }),
        call("Grep", { target: "needle" }),
        call("Read", { paths: ["src/wrong.ts"] }),
        call("Read", { paths: ["src/right.ts"] }),
        call("Edit", { paths: ["src/right.ts"] }),
    ];

    // Three calls came before the first touch of the file that was edited.
    expect(readingOf(calls, ["src/right.ts"]).callsBeforeTarget).toBe(3);
    // A turn that edited the file it opened first walked two calls, not four.
    expect(readingOf(calls, ["src/wrong.ts"]).callsBeforeTarget).toBe(2);
    // Editing both is one walk, to whichever came first.
    expect(readingOf(calls, ["src/right.ts", "src/wrong.ts"]).callsBeforeTarget).toBe(2);
});

test("a turn that edited nothing has no reading rather than a reading of zero", () => {
    expect(readingOf([call("Bash", { target: "ls" })]).callsBeforeTarget).toBeUndefined();
    // Nor an edit never named by a call's locations: honest degradation for a runtime reporting a bare diff.
    expect(readingOf([call("Read", { paths: ["src/a.ts"] })], ["src/elsewhere.ts"]).callsBeforeTarget).toBeUndefined();
});

test("a failure is counted once per call, however often it is reported", () => {
    const metrics = createTurnMetrics(ROOT);
    metrics.call(call("Bash", { target: "pnpm test" }));
    metrics.call(call("Bash", { target: "pnpm build" }));
    metrics.failed("first");
    metrics.failed("first");
    metrics.failed("second");
    expect(metrics.reading([]).failedCalls).toBe(2);
    expect(metrics.calls()).toBe(2);
});
