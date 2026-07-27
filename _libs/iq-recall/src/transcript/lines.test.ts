import { expect, test } from "vitest";
import { fileTouchesOf, parseLine, typedPromptOf } from "./lines.js";

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
