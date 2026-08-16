import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { SecretAccess, SecretUseReport } from "../agent/agent-secrets.js";
import type { JsExecutionPlan } from "./js-runtime.js";
import { type JsToolDeps, runJsTool } from "./js-tool.js";

/* The handler end to end — real scripts through the bare handler, because the server wrapper is registration
 * and the SDK's to test. What the model is told, and the answer's shape, are pinned in js-tool.test.ts. */

const dirPlan = (dir: string, overrides: Partial<JsExecutionPlan> = {}): JsExecutionPlan => ({
    cwd: dir,
    env: {},
    readRoots: [dir],
    writeRoots: [dir],
    allowSpawn: false,
    ...overrides,
});

const deps = (plan: JsExecutionPlan, secrets?: SecretAccess): JsToolDeps => ({
    plan,
    placement: undefined,
    signal: new AbortController().signal,
    ...(secrets === undefined ? {} : { secrets }),
});

test("the handler runs the script and answers in the shell shape", async () => {
    const dir = mkdtempSync(join(tmpdir(), "js-tool-"));
    const answer = await runJsTool(deps(dirPlan(dir)), { code: "console.log(21 * 2);" });
    expect(answer).toBe("42\n\nexit 0");
});

const stored = (uses: SecretUseReport[]): SecretAccess => ({
    list: async () => [{ name: "API_TOKEN", value: "sk-live-abc", source: "env" }],
    used: (use) => uses.push(use),
});

test("a secret reference resolves on the way into the process and the use is filed on the code lane", async () => {
    const dir = mkdtempSync(join(tmpdir(), "js-tool-"));
    const uses: SecretUseReport[] = [];
    const answer = await runJsTool(deps(dirPlan(dir), stored(uses)), {
        code: 'console.log("token is", "{{secret:API_TOKEN}}".length);',
    });
    // The VALUE reached the script (11 chars; the unresolved reference would be 20) — measured, never echoed.
    expect(answer).toContain("token is 11");
    expect(uses).toEqual([{ name: "API_TOKEN", lane: "code", detail: expect.stringContaining("token is") }]);
});

test("an unknown reference refuses the run and names what exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "js-tool-"));
    const uses: SecretUseReport[] = [];
    const answer = await runJsTool(deps(dirPlan(dir), stored(uses)), { code: 'console.log("{{secret:NOPE}}");' });
    expect(answer).toContain('no stored secret named "NOPE"');
    expect(answer).toContain("API_TOKEN");
    expect(uses).toEqual([]);
});

test("the timeout ask reaches the kill, and the status line names it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "js-tool-"));
    const answer = await runJsTool(deps(dirPlan(dir)), {
        code: "await new Promise((resolve) => setTimeout(resolve, 60_000));",
        timeoutSeconds: 1,
    });
    expect(answer).toContain("killed: still running at the 1s timeout");
}, 15_000);
