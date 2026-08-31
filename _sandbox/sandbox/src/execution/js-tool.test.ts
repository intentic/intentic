import { expect, test } from "vitest";
import type { JsExecutionPlan } from "./js-runtime.js";
import { formatJsResult, JS_SERVER_NAME, JS_TOOL_NAME, jsToolDescription } from "./js-tool.js";

/* The loop-facing half of the backend, pure part: what the model is told, and the shape a run answers in.
 * The handler itself runs real scripts and lives in js-tool.integration.test.ts. */

const dirPlan = (dir: string, overrides: Partial<JsExecutionPlan> = {}): JsExecutionPlan => ({
    cwd: dir,
    env: {},
    readRoots: [dir],
    writeRoots: [dir],
    allowSpawn: false,
    ...overrides,
});

// The three names the mount, the alias and the gate matcher agree on: pinned against each other so a rename
// in one place fails here rather than as a tool that silently stops being gated.
test("the tool name is the server name in the SDK's own spelling", () => {
    expect(JS_TOOL_NAME).toBe(`mcp__${JS_SERVER_NAME}__run`);
});

test("a run's answer reads like a shell's: output, then the status", () => {
    expect(formatJsResult({ exitCode: 0, timedOut: false, stdout: "4\n", stderr: "" }, 120)).toBe("4\n\nexit 0");
    expect(formatJsResult({ exitCode: 1, timedOut: false, stdout: "", stderr: "boom" }, 120)).toBe("--- stderr ---\nboom\nexit 1");
    expect(formatJsResult({ exitCode: 0, timedOut: false, stdout: "", stderr: "" }, 120)).toBe("(no output)\nexit 0");
    expect(formatJsResult({ exitCode: undefined, timedOut: true, stdout: "partial", stderr: "" }, 30)).toBe(
        "partial\nkilled: still running at the 30s timeout",
    );
    expect(formatJsResult({ exitCode: undefined, timedOut: false, stdout: "", stderr: "" }, 30)).toContain("killed before exiting");
});

/* The description is the model's contract with the fence, so its load-bearing sentences are pinned: the scoped
 * roots it names, the no-spawn refusal that closes the bash-through-code road, and the honesty note about the
 * network: the one thing the fence cannot cut. */
test("the description tells the truth the plan enforces", () => {
    const open = jsToolDescription(dirPlan("/work", { allowSpawn: true }));
    expect(open).toContain("/work");
    expect(open).toContain("child_process");

    const fenced = jsToolDescription(dirPlan("/work", { writeRoots: [], allowSpawn: false }));
    expect(fenced).toContain("/work");
    expect(fenced).not.toContain("child_process");

    const noFs = jsToolDescription(dirPlan("/work", { readRoots: [], writeRoots: [] }));
    expect(noFs).toContain("NO filesystem access");

    // Every variant carries the secret-reference teaching.
    for (const text of [open, fenced, noFs]) {
        expect(text).toContain("{{secret:name}}");
    }
});
