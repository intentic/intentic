import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PostToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { syncHookOutput } from "../run/harness/harness-hooks.testing.js";
import { searchProbeHooks } from "./search-probe-hooks.js";

// An empty Grep over a real tree, probed by a real rg: the agent is told the files a changed switch would have found.

let root: string;

const put = async (path: string, content: string): Promise<void> => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
};

beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "grep-probes-"));
    execFileSync("git", ["init", "-q", root]);
    await put(".gitignore", "dist/\n");
    await put("src/widget.ts", "export const FooBar = 1;\n");
    await put("dist/bundle.js", "var onlyBuilt = 1;\n");
    await put(".config/settings.json", '{ "hiddenSetting": true }\n');
});
afterAll(() => rm(root, { recursive: true, force: true }));

const grep = async (toolInput: Record<string, unknown>): Promise<string | undefined> => {
    const [matcher] = searchProbeHooks().PostToolUse ?? [];
    const input: PostToolUseHookInput = {
        hook_event_name: "PostToolUse",
        tool_name: "Grep",
        tool_input: toolInput,
        tool_response: { mode: "files_with_matches", numFiles: 0, filenames: [] },
        tool_use_id: "t1",
        session_id: "",
        transcript_path: "",
        cwd: root,
    };
    const output = syncHookOutput((await matcher?.hooks[0]?.(input, "t1", { signal: new AbortController().signal })) ?? {});
    const specific = output.hookSpecificOutput;
    return specific?.hookEventName === "PostToolUse" ? specific.additionalContext : undefined;
};

test("a casing miss names the file any case finds", async () => {
    expect(await grep({ pattern: "foobar" })).toBe('no matches. Would match: case-insensitive ("-i": true) → 1 file (src/widget.ts)');
});

test("a match only in a gitignored file is named; Grep's own --hidden means a hidden file needs no probe", async () => {
    expect(await grep({ pattern: "onlyBuilt" })).toContain("in gitignored files, which Grep skips (rg -u in Bash searches them) → 1 file (dist/bundle.js)");
    // Grep searched .config already, so a miss there is a real miss.
    expect(await grep({ pattern: "absentSetting" })).toBeUndefined();
});
