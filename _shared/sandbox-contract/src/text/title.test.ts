import { expect, test } from "vitest";
import { AgentTurnSchema } from "../schemas/agent.js";
import { deriveTitle } from "./title.js";

// Titles deriveTitle produces; every case here is a shape a naive collapse-and-cut-at-40 rule got noticeably wrong.

test("spends the budget on the ask rather than on the politeness in front of it", () => {
    expect(deriveTitle("Can you please fix the auth tests?")).toBe("Fix the auth tests?");
    expect(deriveTitle("Hey, can you please look at the flaky test")).toBe("Look at the flaky test");
});

test("keeps a greeting whole when peeling it off would leave a fragment", () => {
    expect(deriveTitle("Hi there")).toBe("Hi there");
    expect(deriveTitle("So what?")).toBe("So what?");
});

test("titles a pasted stack trace after the sentence the user wrote around it", () => {
    const prompt = [
        "The build is broken again.",
        "",
        "```",
        "Error: ENOENT: no such file or directory",
        "  at Object.openSync (node:fs)",
        "```",
    ].join("\n");

    expect(deriveTitle(prompt)).toBe("The build is broken again");
});

test("skips a greeting line and takes the ask from the line below it", () => {
    expect(deriveTitle("Hey, quick one —\n\nWhy does the tab title truncate mid-word?")).toBe("Why does the tab title truncate mid-word?");
});

test("keeps an ask that fits the registry's 80-character budget instead of cutting at 40", () => {
    // Matches the registry's stored-title budget, not an arbitrary length.
    const prompt = "In intentic-app/web when conflicts happen during rebase show a resolution banner";

    expect(deriveTitle(prompt)).toBe(prompt);
});

test("cuts on a word boundary instead of mid-syllable", () => {
    const prompt = "Why does the tab title truncate mid-word even though the strip clearly still has unused horizontal room?";
    const title = deriveTitle(prompt);
    const kept = title.slice(0, -1);

    expect(title.endsWith("…")).toBe(true);
    expect(prompt.startsWith(kept)).toBe(true);
    expect(prompt[kept.length]).toBe(" ");
});

test("keeps a cut it cannot put on a word boundary inside the budget anyway", () => {
    // The clamp alone ends the title when no boundary is late enough; overshooting the schema's cap even by one char
    // wedges every retry, since the browser stores the title before sending.
    const prompt = `In one of the sandboxes I have experienced "CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS" limit of 20. Make it configurable in sandbox settings somewhere at /sandbox/agent`;
    const title = deriveTitle(prompt);

    expect(title.endsWith("…")).toBe(true);
    // Checked against the contract, not a repeated literal: a second copy of the cap is how it would drift.
    expect(AgentTurnSchema.safeParse({ prompt, title }).success).toBe(true);
    // Not a property of that one sentence: any token wide enough to swallow the window triggers it.
    const wide = `Investigate ${"X".repeat(120)} please`;
    expect(AgentTurnSchema.safeParse({ prompt: wide, title: deriveTitle(wide) }).success).toBe(true);
});

test("keeps a link's last meaningful segment rather than its host and scaffolding", () => {
    const title = deriveTitle("Look at https://gitlab.com/radarsu/intentic/-/merge_requests/42 and tell me what broke");

    // A numeric tail alone ("42") would name nothing, so the segment above it comes along.
    expect(title).toContain("merge_requests/42");
    expect(title).not.toContain("gitlab.com");
});

test("collapses a deep path to its basename and leaves a shallow one alone", () => {
    expect(deriveTitle("Refactor _editor/web/src/composables/chat/conversation.ts")).toBe("Refactor conversation.ts");
    // Two segments already read as a place; collapsing would lose the reference's only context.
    expect(deriveTitle("Refactor src/foo.ts")).toBe("Refactor src/foo.ts");
});

test("ends on the first sentence when the prompt keeps going", () => {
    expect(deriveTitle("Fix the flaky test. It fails about one run in five, usually on CI.")).toBe("Fix the flaky test");
});

test("does not mistake an abbreviation for the end of a sentence", () => {
    // Would otherwise cut to `i.e`, naming nothing.
    expect(deriveTitle("i.e. the derived title should survive")).toBe("i.e. the derived title should survive");
});

test("leaves casing alone when the opening word carries meaning in its casing", () => {
    expect(deriveTitle("useAgents leaks a watcher on unmount")).toBe("useAgents leaks a watcher on unmount");
    expect(deriveTitle("fix the leaking watcher")).toBe("Fix the leaking watcher");
});

test("names a prompt that is nothing but a paste after what was pasted", () => {
    expect(deriveTitle("```ts\nconst x = 1;\n```")).toBe("const x = 1;");
});

test("never returns empty for a prompt that has any content at all", () => {
    // A greeting with no ask, and a prompt with no letters at all: both still must name a tab.
    expect(deriveTitle("Hey!")).toBe("Hey!");
    expect(deriveTitle("!!!")).toBe("!!!");
});

test("reads past quoted material to the user's own words", () => {
    expect(deriveTitle("> previous message\nWhat changed here?")).toBe("What changed here?");
});

test("skips past-work narration to the instruction behind it", () => {
    expect(deriveTitle("We have recently added iq map and iq deps commands. Now let's also add a health contract for the daemon.")).toBe(
        "Add a health contract for the daemon",
    );
    expect(deriveTitle("We've just landed the fleet board.\n\nRename the Attention lane to Blocked.")).toBe("Rename the Attention lane to Blocked");
});

test("skips narration to an outright question", () => {
    expect(deriveTitle("I've implemented the empty state. What should the loading state show?")).toBe("What should the loading state show?");
});

test("keeps narration when nothing behind it is unmistakably the ask", () => {
    // Not worth skipping for: a vague follow-up like "it" is worse context than the sentence before it.
    expect(deriveTitle("We migrated the board to SSE last week. It feels slower since.")).toBe("We migrated the board to SSE last week");
});

test("keeps a declarative problem report even when advice follows it", () => {
    // Only narration is skippable; an imperative like "Check the broadcast path" names a step, not the ask.
    expect(deriveTitle("The fleet board flickers when agents land. Check the broadcast path.")).toBe("The fleet board flickers when agents land");
});

test("strips control characters the same way the registry's sanitiser does", () => {
    expect(deriveTitle("Fix\u0000 the\u200b bug")).toBe("Fix the bug");
});
