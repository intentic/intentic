import { sizingPrompt } from "./subagent-sizing.js";

// The one question a contested placement asks: what the task will make its machine do, from the parent's own words.

test("the task travels whole up to its cap, with its title, and the question leans heavy when in doubt", () => {
    const prompt = sizingPrompt({ prompt: "Run the vitest suite for _editor/web and fix what fails.", description: "Fix editor tests" });
    expect(prompt).toContain("TITLE: Fix editor tests");
    expect(prompt).toContain("Run the vitest suite for _editor/web and fix what fails.");
    expect(prompt).toContain("answer HEAVY");
    const long = sizingPrompt({ prompt: `read ${"x".repeat(5_000)}` });
    expect(long).toContain("… (truncated)");
    expect(long).not.toContain("TITLE:");
    expect(long.length).toBeLessThan(3_000);
});
