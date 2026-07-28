import { expect, test } from "vitest";
import { deriveTitle } from "./title.js";

/* The name a conversation opens under. Every case here is a shape the naive rule (collapse whitespace, cut at
 * 40) got wrong in a way a user notices: the title named the paste instead of the work, spent the budget on
 * politeness, or stopped mid-syllable. */

test("spends the budget on the ask rather than on the politeness in front of it", () => {
    // `Can you please fix the auth…` is what the naive cut produced — three of its five words are ceremony.
    expect(deriveTitle("Can you please fix the auth tests?")).toBe("Fix the auth tests?");
    expect(deriveTitle("Hey, can you please look at the flaky test")).toBe("Look at the flaky test");
});

test("keeps a greeting whole when peeling it off would leave a fragment", () => {
    // `Hi there` is not a conversation about `there`, and `So what?` is not one about `what?` — a one-word
    // remnant means the opener was carrying the sentence, so the line stands as the user wrote it.
    expect(deriveTitle("Hi there")).toBe("Hi there");
    expect(deriveTitle("So what?")).toBe("So what?");
});

test("titles a pasted stack trace after the sentence the user wrote around it", () => {
    // The paste is evidence, not the ask. Titling from it gives every one of the day's pastes the same name.
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
    // A line that unwinds to nothing was throat-clearing; the ask is further down. The naive rule stopped at
    // the greeting and named every such conversation `Hey, quick one —`.
    expect(deriveTitle("Hey, quick one —\n\nWhy does the tab title truncate mid-word?")).toBe("Why does the tab title truncate mid-word?");
});

test("keeps an ask that fits the registry's 80-character budget instead of cutting at 40", () => {
    // The old 40-character clamp cut this to `In intentic-app/web when conflict…` on a fleet card that had
    // room for twice that. The stored title matches what the registry and the rename input accept.
    const prompt = "In intentic-app/web when conflicts happen during rebase show a resolution banner";

    expect(deriveTitle(prompt)).toBe(prompt);
});

test("cuts on a word boundary instead of mid-syllable", () => {
    const prompt = "Why does the tab title truncate mid-word even though the strip clearly still has unused horizontal room?";
    const title = deriveTitle(prompt);
    const kept = title.slice(0, -1);

    expect(title.endsWith("…")).toBe(true);
    // The old rule sliced at exactly 40, ending this title inside `mid-word`. Every word that survives has to
    // be a whole one, so what precedes the ellipsis must stop where the prompt itself has a break.
    expect(prompt.startsWith(kept)).toBe(true);
    expect(prompt[kept.length]).toBe(" ");
});

test("keeps a link's last meaningful segment rather than its host and scaffolding", () => {
    const title = deriveTitle("Look at https://gitlab.com/radarsu/intentic/-/merge_requests/42 and tell me what broke");

    // A numeric tail alone (`42`) names nothing, so the segment above it comes along.
    expect(title).toContain("merge_requests/42");
    expect(title).not.toContain("gitlab.com");
});

test("collapses a deep path to its basename and leaves a shallow one alone", () => {
    expect(deriveTitle("Refactor _apps/web/src/composables/chat/conversation.ts")).toBe("Refactor conversation.ts");
    // Two segments already read as a place; collapsing them would lose the only context the reference carries.
    expect(deriveTitle("Refactor src/foo.ts")).toBe("Refactor src/foo.ts");
});

test("ends on the first sentence when the prompt keeps going", () => {
    expect(deriveTitle("Fix the flaky test. It fails about one run in five, usually on CI.")).toBe("Fix the flaky test");
});

test("does not mistake an abbreviation for the end of a sentence", () => {
    // `i.e.` would otherwise cut the title to `i.e`, which names nothing at all.
    expect(deriveTitle("i.e. the derived title should survive")).toBe("i.e. the derived title should survive");
});

test("leaves casing alone when the opening word carries meaning in its casing", () => {
    expect(deriveTitle("useAgents leaks a watcher on unmount")).toBe("useAgents leaks a watcher on unmount");
    expect(deriveTitle("fix the leaking watcher")).toBe("Fix the leaking watcher");
});

test("names a prompt that is nothing but a paste after what was pasted", () => {
    // Returning empty here would render a nameless tab; the first line of the paste at least says what it is.
    expect(deriveTitle("```ts\nconst x = 1;\n```")).toBe("const x = 1;");
});

test("never returns empty for a prompt that has any content at all", () => {
    // A greeting with no ask behind it, and a prompt with no letters in it — both still have to name a tab.
    expect(deriveTitle("Hey!")).toBe("Hey!");
    expect(deriveTitle("!!!")).toBe("!!!");
});

test("reads past quoted material to the user's own words", () => {
    expect(deriveTitle("> previous message\nWhat changed here?")).toBe("What changed here?");
});

test("strips control characters the same way the registry's sanitiser does", () => {
    expect(deriveTitle("Fix\u0000 the\u200b bug")).toBe("Fix the bug");
});
