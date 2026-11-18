import { promptOf, type PromptKind } from "./transcript-lines.js";

// Every user-line shape the CLI writes, as real transcripts carry them, and what each is.
const USER_LINES: readonly (readonly [string, Record<string, unknown>, PromptKind, string])[] = [
    ["a plain prompt", { message: { content: "fix the parser" } }, "typed", "fix the parser"],
    [
        "text blocks",
        {
            message: {
                content: [
                    { type: "text", text: "one" },
                    { type: "text", text: "two" },
                ],
            },
        },
        "typed",
        "one\ntwo",
    ],
    ["an image-only prompt", { message: { content: [{ type: "image", source: { type: "base64", data: "" } }] } }, "typed", ""],
    [
        "a slash command",
        { message: { content: "<command-message>review</command-message>\n<command-name>/review</command-name>" } },
        "command",
        "<command-message>review</command-message>\n<command-name>/review</command-name>",
    ],
    [
        "a local command's output",
        { message: { content: [{ type: "text", text: "<local-command-stdout>ok</local-command-stdout>" }] } },
        "local-command",
        "<local-command-stdout>ok</local-command-stdout>",
    ],
    [
        "a compaction summary",
        { isCompactSummary: true, message: { content: "This session is being continued from a previous conversation." } },
        "compaction",
        "This session is being continued from a previous conversation.",
    ],
    [
        "an interruption",
        { message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } },
        "interruption",
        "[Request interrupted by user]",
    ],
    [
        "an interruption during a tool call",
        { message: { content: "[Request interrupted by user for tool use]" } },
        "interruption",
        "[Request interrupted by user for tool use]",
    ],
    ["a harness line", { isMeta: true, message: { content: "Continue from where you left off." } }, "meta", "Continue from where you left off."],
    ["tool results", { message: { content: [{ type: "tool_result", tool_use_id: "t", content: "x" }] } }, "tool-result", ""],
];

test.each(USER_LINES)("promptOf reads %s", (_, fields, kind, text) => {
    expect(promptOf({ type: "user", ...fields })).toEqual({ kind, text });
});

test("promptOf leaves non-user lines and contentless user lines alone", () => {
    expect(promptOf({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } })).toBeUndefined();
    expect(promptOf({ type: "user" })).toBeUndefined();
});
