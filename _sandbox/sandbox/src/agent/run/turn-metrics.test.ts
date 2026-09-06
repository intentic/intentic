import type { AgentEvent } from "@intentic/sandbox-contract";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { expect, test } from "vitest";
import { createTurnMetrics } from "./turn-metrics.js";
import { toolCategoryOf } from "../tools/tool-calls.js";

/* The four readings the mechanism experiments are judged on, and every one of them is a claim about ORDER: the
 * same calls in a different sequence are a different turn. So the fixtures here are sequences, and the numbers
 * are arithmetic over them rather than a snapshot of what the ledger happened to say. */

let id = 0;
const call = (name: string, over: { target?: string; paths?: string[] } = {}): AgentEvent => ({
    kind: "tool_call",
    id: `t${(id += 1)}`,
    name,
    // Through the production mapping, so a call scores here exactly as it scores in a turn.
    category: toolCategoryOf(name),
    status: "completed",
    ...(over.target === undefined ? {} : { target: over.target }),
    ...(over.paths === undefined ? {} : { locations: over.paths.map((path) => ({ path })) }),
});

const readingOf = (events: readonly AgentEvent[], edited: readonly string[] = []) => {
    const metrics = createTurnMetrics(WORKSPACE_ROOT);
    for (const event of events) {
        metrics.note(event);
    }
    return { ...metrics.reading(edited), calls: metrics.calls() };
};

test("orientation is counted up to the first file, and listings are counted apart from searches", () => {
    const reading = readingOf([
        call("Bash", { target: "ls" }),
        call("Bash", { target: "rg needle" }),
        call("Read", { paths: ["src/a.ts"] }),
        // Past the first file: still a search, no longer orientation, and no longer a listing the map could
        // have answered.
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

/* THE TARGET IS ONLY KNOWN AT THE END, which is the whole reason this reading lives on a ledger rather than in
 * a counter: the file that turned out to matter is decided by what the turn edited, long after the call that
 * first opened it. */
test("calls before the target count the walk up to the file the turn went on to edit", () => {
    const events = [
        call("Bash", { target: "ls" }),
        call("Grep", { target: "needle" }),
        call("Read", { paths: ["src/wrong.ts"] }),
        call("Read", { paths: ["src/right.ts"] }),
        call("Edit", { paths: ["src/right.ts"] }),
    ];

    // Three calls came before the first touch of the file that was edited.
    expect(readingOf(events, ["src/right.ts"]).callsBeforeTarget).toBe(3);
    // A turn that edited the file it opened first walked two calls, not four.
    expect(readingOf(events, ["src/wrong.ts"]).callsBeforeTarget).toBe(2);
    // Editing both is one walk, to whichever came first.
    expect(readingOf(events, ["src/right.ts", "src/wrong.ts"]).callsBeforeTarget).toBe(2);
});

test("a turn that edited nothing has no reading rather than a reading of zero", () => {
    expect(readingOf([call("Bash", { target: "ls" })]).callsBeforeTarget).toBeUndefined();
    // …and neither does one whose edit was never named by a call's locations, which is the honest degradation
    // for a runtime that reports an edit as a bare diff.
    expect(readingOf([call("Read", { paths: ["src/a.ts"] })], ["src/elsewhere.ts"]).callsBeforeTarget).toBeUndefined();
});

test("an update is a later state of a call already counted, never a second call", () => {
    const opened = call("Bash", { target: "ls" });
    const reading = readingOf([opened, { kind: "tool_call_update", id: opened.kind === "tool_call" ? opened.id : "", status: "completed" }]);
    expect(reading).toMatchObject({ calls: 1, openingListings: 1 });
});
