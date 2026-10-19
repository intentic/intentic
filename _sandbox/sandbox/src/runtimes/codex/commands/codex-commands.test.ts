import { readCodexReview, reviewTargetIn, reviewTargetOf } from "./codex-commands.js";

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

// A fresh session's cut committed its origin's work, so a bare `/review` there reviews the ranges it carries rather than
// uncommitted changes that are none; words the person typed after `/review` still say what to look at.
test("a bare /review in a turn carrying a scope reviews that scope, and typed words still win", () => {
    const scope = "Review the code changes in these ranges, each run from the checkout's root:\n- `git diff 1234567890ab...HEAD` (the workspace root)";
    expect(reviewTargetIn("/review", [], scope)).toEqual({ type: "custom", instructions: scope });
    expect(reviewTargetIn("/review  ", [], scope)).toEqual({ type: "custom", instructions: scope });
    expect(reviewTargetIn("/review branch main", [], scope)).toEqual({ type: "baseBranch", branch: "main" });
    expect(reviewTargetIn("/review", [])).toEqual({ type: "uncommittedChanges" });
    expect(reviewTargetIn("/review", [{ name: "review", description: "", path: "/skills/review" }], scope)).toBeUndefined();
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
