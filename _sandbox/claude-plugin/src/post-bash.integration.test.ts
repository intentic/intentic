import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseStatsFile } from "@intentic/output-cleaners/stats";
import type { HookInput } from "./hook-io.js";
import { outputDir, postBash } from "./post-bash.js";

// The Bash hook against a real data directory: what Claude reads instead of the raw output, what it keeps, and every
// case where it must answer nothing and let Claude Code keep the original.

const dirs: string[] = [];
const tempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "intentic-post-bash-"));
    dirs.push(dir);
    return dir;
};

afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

const LONG = `${Array.from({ length: 300 }, (_, index) => `building module ${index}`).join("\n")}\n`;

const call = (over: Partial<HookInput> = {}): HookInput => ({
    session_id: "s-1",
    cwd: "/src/app",
    tool_name: "Bash",
    tool_use_id: "toolu_1",
    duration_ms: 2400,
    tool_input: { command: "./build.sh" },
    tool_response: { stdout: LONG, stderr: "", interrupted: false, isImage: false, noOutputExpected: false },
    ...over,
});

test("a long output reaches Claude trimmed, in the tool's own shape, with the raw text kept and ledgered", () => {
    const data = tempDir();
    const answer = postBash(call(), { CLAUDE_PLUGIN_DATA: data, CLAUDE_PROJECT_DIR: "/src/app" }) as {
        hookSpecificOutput: { hookEventName: string; updatedToolOutput: Record<string, unknown> };
    };
    expect(answer.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    const output = answer.hookSpecificOutput.updatedToolOutput;
    const raw = join(outputDir(data), "raw-output", "s-1-toolu_1.log");
    expect(output["stdout"]).toContain(`--- [exit 0, 2s] 300 lines filtered to 81 · full: retrieve-output ${raw} [pattern]`);
    // Every field the tool answered with survives; only the text changed.
    expect(output).toMatchObject({ stderr: "", interrupted: false, isImage: false, noOutputExpected: false });
    expect(readFileSync(raw, "utf8")).toBe(LONG.trimEnd());
    const rows = parseStatsFile(readFileSync(join(outputDir(data), "filter-stats.jsonl"), "utf8"));
    expect(rows[0]).toMatchObject({ project: "/src/app", session: "s-1", command: "./build.sh", rawBytes: LONG.length });
});

test("stderr is read after stdout, as Claude would have read them", () => {
    const answer = postBash(call({ tool_response: { stdout: LONG, stderr: "warning: deprecated flag\n" } }), { CLAUDE_PLUGIN_DATA: tempDir() }) as {
        hookSpecificOutput: { updatedToolOutput: { stdout: string } };
    };
    expect(answer.hookSpecificOutput.updatedToolOutput.stdout).toContain("warning: deprecated flag");
});

test("answers nothing when there is nothing to change or nothing it should touch", () => {
    const env = { CLAUDE_PLUGIN_DATA: tempDir() };
    // Switched off.
    expect(postBash(call(), { ...env, CLAUDE_PLUGIN_OPTION_OUTPUT_CLEANERS: "false" })).toBeUndefined();
    // A short output the cleaners leave as it is.
    expect(postBash(call({ tool_response: { stdout: "ok\n", stderr: "" } }), env)).toBeUndefined();
    // Cut short, an image, or still running in the background: not a finished text to clean.
    expect(postBash(call({ tool_response: { stdout: LONG, stderr: "", interrupted: true } }), env)).toBeUndefined();
    expect(postBash(call({ tool_response: { stdout: LONG, stderr: "", isImage: true } }), env)).toBeUndefined();
    expect(postBash(call({ tool_response: { stdout: "", stderr: "", backgroundTaskId: "b1" } }), env)).toBeUndefined();
    // The plugin's own reports are budgeted already.
    expect(postBash(call({ tool_input: { command: 'intentic-stats --data "/d" --project "/p"' } }), env)).toBeUndefined();
    // A payload that is not a Bash result at all.
    expect(postBash(call({ tool_response: "not an object" }), env)).toBeUndefined();
});
