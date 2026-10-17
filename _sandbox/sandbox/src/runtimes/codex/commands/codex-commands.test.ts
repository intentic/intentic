import { readCodexReview, reviewTargetOf } from "./codex-commands.js";

test("review words name what the reviewer looks at", () => {
    expect(reviewTargetOf("")).toEqual({ type: "uncommittedChanges" });
    expect(reviewTargetOf("uncommitted")).toEqual({ type: "uncommittedChanges" });
    expect(reviewTargetOf("branch main")).toEqual({ type: "baseBranch", branch: "main" });
    expect(reviewTargetOf("base release/2.1")).toEqual({ type: "baseBranch", branch: "release/2.1" });
    expect(reviewTargetOf("commit 4f7c1416ec")).toEqual({ type: "commit", sha: "4f7c1416ec", title: null });
    expect(reviewTargetOf("4f7c1416ec")).toEqual({ type: "commit", sha: "4f7c1416ec", title: null });
    // Words that only look like a target are what the reviewer is asked to look at.
    expect(reviewTargetOf("branch")).toEqual({ type: "custom", instructions: "branch" });
    expect(reviewTargetOf("commit the parser")).toEqual({ type: "custom", instructions: "commit the parser" });
    expect(reviewTargetOf("abc")).toEqual({ type: "custom", instructions: "abc" });
});

test("a clean review is a card with no findings; a reviewer that said nothing, or a list this reader cannot make out, is prose alone", () => {
    expect(readCodexReview("The change is correct.")).toEqual({ prose: "The change is correct.", findings: [] });
    expect(readCodexReview("Reviewer failed to output a response.")).toEqual({ prose: "Reviewer failed to output a response." });
    expect(readCodexReview("Some notes:\n- a thing at a place")).toEqual({ prose: "Some notes:\n- a thing at a place" });
    expect(readCodexReview("Word.\n\nFull review comments:\n\n- nothing parseable")).toEqual({ prose: "Word.\n\nFull review comments:\n\n- nothing parseable" });
});

test("a single comment, a checked selection and a block with no word ahead of it all read", () => {
    const read = readCodexReview("Review comment:\n\n- [x] [P0] Null deref — src/a.ts:3\n  `user` may be null.");
    expect(read).toEqual({ prose: "", findings: [{ file: "src/a.ts", line: 3, summary: "Null deref", priority: 0, body: "`user` may be null." }] });
});
