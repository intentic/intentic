import { expect, test } from "vitest";
import { parseEnvBlock, splitCommand } from "./acp-spawn.js";

test("splitCommand splits on whitespace (no shell quoting by design)", () => {
    expect(splitCommand("opencode acp")).toEqual(["opencode", "acp"]);
    expect(splitCommand("  npx  -y @zed-industries/codex-acp ")).toEqual(["npx", "-y", "@zed-industries/codex-acp"]);
});

test("parseEnvBlock reads KEY=VALUE lines, skips blanks/comments, keeps = in values", () => {
    expect(parseEnvBlock("GEMINI_API_KEY=abc\n\n# comment\nTOKEN=a=b\n=broken\nnoequals")).toEqual({
        GEMINI_API_KEY: "abc",
        TOKEN: "a=b",
    });
    expect(parseEnvBlock(undefined)).toEqual({});
});
