import { fileTouchesOf, parseLine, promptOf, typedPromptOf, type PromptKind } from "./lines.js";

test("parseLine tolerates malformed and non-object json", () => {
    expect(parseLine("not json")).toBeUndefined();
    expect(parseLine('"a string"')).toBeUndefined();
    expect(parseLine("[1]")).toBeUndefined();
    expect(parseLine('{"type":"user"}')).toEqual({ type: "user" });
});

test("typedPromptOf accepts both content shapes and filters non-prompts", () => {
    expect(typedPromptOf({ type: "user", message: { content: "plain old-format prompt" } })).toBe("plain old-format prompt");
    expect(typedPromptOf({ type: "user", message: { content: [{ type: "text", text: "array prompt" }] } })).toBe("array prompt");
    expect(typedPromptOf({ type: "user", isMeta: true, message: { content: "<local-command-caveat>x</local-command-caveat>" } })).toBeUndefined();
    expect(typedPromptOf({ type: "user", message: { content: "<command-name>/model</command-name>" } })).toBeUndefined();
    expect(typedPromptOf({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t", content: "x" }] } })).toBeUndefined();
    expect(typedPromptOf({ type: "assistant", message: { content: [{ type: "text", text: "not a user line" }] } })).toBeUndefined();
});

// Every user-line shape the CLI writes, as real transcripts carry them, and what each is. @intentic/agent-context reads
// turn boundaries through the same classification, so a shape added here is settled for both readers.
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

test("typedPromptOf is the typed kind with text, so compactions, interruptions and image-only prompts are not searched as typed", () => {
    expect(USER_LINES.filter(([, fields]) => typedPromptOf({ type: "user", ...fields }) !== undefined).map(([name]) => name)).toEqual([
        "a plain prompt",
        "text blocks",
    ]);
});

test("fileTouchesOf covers tool_use inputs, toolUseResult payloads, and snapshots", () => {
    expect(
        fileTouchesOf({
            type: "assistant",
            message: {
                content: [
                    { type: "tool_use", name: "Read", input: { file_path: "/w/read.ts" } },
                    { type: "tool_use", name: "Edit", input: { file_path: "/w/edit.ts", old_string: "a", new_string: "b" } },
                    { type: "tool_use", name: "NotebookEdit", input: { notebook_path: "/w/nb.ipynb" } },
                    { type: "tool_use", name: "Bash", input: { command: "rm -rf /w/ignored.ts" } },
                ],
            },
        }),
    ).toEqual([
        { path: "/w/read.ts", modified: false },
        { path: "/w/edit.ts", modified: true },
        { path: "/w/nb.ipynb", modified: true },
    ]);
    expect(fileTouchesOf({ type: "user", toolUseResult: { type: "text", file: { filePath: "/w/read.ts" } } })).toEqual([
        { path: "/w/read.ts", modified: false },
    ]);
    expect(fileTouchesOf({ type: "user", toolUseResult: { filePath: "/w/edit.ts", structuredPatch: [] } })).toEqual([
        { path: "/w/edit.ts", modified: true },
    ]);
    expect(fileTouchesOf({ type: "file-history-snapshot", snapshot: { trackedFileBackups: { "/w/snap.ts": { backupId: "b" } } } })).toEqual([
        { path: "/w/snap.ts", modified: true },
    ]);
});
