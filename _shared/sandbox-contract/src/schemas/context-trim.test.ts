import { contextTrimLine } from "./context-trim.js";

// The one thing a reader ever sees of this mechanism. It has to answer three questions in one line: why the turn ran
// thin, what it lost, and whether the reader's own instructions were among the losses.

test("the window comes first, then what went, then what stayed", () => {
    const line = contextTrimLine({ window: 16_384, omitted: ["Map of this project", "Working in this sandbox"], base: true });

    expect(line).toContain("16k window");
    expect(line).toContain("Map of this project, Working in this sandbox");
    // Without this clause the line reads as "your AGENTS.md may not have arrived", which is the one thing it is not.
    expect(line).toContain("Your workspace rules");
});

// A swapped base is a bigger change than any note and is stated as its own fact, not folded into the list.
test("a swapped base says so, and a kept one does not", () => {
    const swapped = contextTrimLine({ window: 16_384, omitted: [], base: true });
    const kept = contextTrimLine({ window: 32_768, omitted: ["Map of this project"], base: false });

    expect(swapped).toContain("base instructions were swapped");
    expect(kept).not.toContain("base instructions");
});

// Nothing to list happens for real: a turn whose optional notes were all off already, on a window small enough to swap
// the base. The sentence must not trail off into an empty list.
test("an empty list leaves no dangling clause", () => {
    const line = contextTrimLine({ window: 16_384, omitted: [], base: true });

    expect(line).toContain("16k window.");
    expect(line).not.toContain("left out");
});

// A user's own server can be started with any number at all, and rounding it to "24k" would misquote the thing the
// reader has to go and change.
test("a window that is not a round number is spelled out", () => {
    expect(contextTrimLine({ window: 24_000, omitted: ["Map of this project"], base: false })).toContain("24,000 window");
});
