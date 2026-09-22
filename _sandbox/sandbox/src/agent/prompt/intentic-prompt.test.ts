import { test, expect } from "bun:test";
import { intenticPromptOf, missedCuts } from "./intentic-prompt.js";

// Shaped like the CLI's own variants: the identity line as its own block, a paragraph whose two IMPORTANT lines are two
// rules, and sections whose subheadings do not end them.
const PRESET = [
    "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
    "\nYou are an interactive agent that helps users with software engineering tasks.",
    "IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges.\nIMPORTANT: You must NEVER generate or guess URLs.",
    "# Harness\n - Text you output outside of tool use is displayed as markdown.\n - Reference code as `file_path:line_number`.",
    "Write code that reads like the surrounding code: match its comment density, naming, and idiom.",
    "When you use a pronoun for someone, use they/them.",
    "For actions that are hard to reverse, confirm first.",
    "# auto memory",
    "You have a persistent, file-based memory system.",
    "## Types of memory\nuser, feedback, project.",
    "# Environment\n - The most recent Claude models are the Claude 5 family.",
    "# Context management\nWhen the conversation grows long, the context is summarized.",
    "<total_tokens>15000000 tokens left</total_tokens>",
].join("\n\n");

test("the preset loses exactly what Intentic replaces, and keeps the rest word for word", () => {
    expect(intenticPromptOf(PRESET)).toBe(
        [
            "You are an interactive agent that helps users with software engineering tasks.",
            // The security line goes; the rule it shares a paragraph with is a different one and stays.
            "IMPORTANT: You must NEVER generate or guess URLs.",
            "# Harness\n - Text you output outside of tool use is displayed as markdown.\n - Reference code as `file_path:line_number`.",
            "For actions that are hard to reverse, confirm first.",
            "# Context management\nWhen the conversation grows long, the context is summarized.",
            "<total_tokens>15000000 tokens left</total_tokens>",
        ].join("\n\n"),
    );
});

// The CLI prefixes its identity line to a string prompt itself, so the base must not carry a second copy.
test("the identity line is left to the CLI", () => {
    expect(intenticPromptOf(PRESET)).not.toContain("Claude Agent SDK");
});

test("a cut section ends at the next heading of its own level, not at a subheading", () => {
    const text = intenticPromptOf(PRESET);
    expect(text).not.toContain("Types of memory");
    expect(text).toContain("# Context management");
});

test("a preset with nothing for a cut names that cut, and one with everything names none", () => {
    expect(missedCuts(PRESET)).toEqual([]);
    const reworded = PRESET.replace("When you use a pronoun", "Use they/them").replace("# Environment", "# Setting");
    expect(missedCuts(reworded)).toEqual(["When you use a pronoun", "# Environment"]);
});
