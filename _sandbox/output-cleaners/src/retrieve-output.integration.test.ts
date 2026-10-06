import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// retrieve-output as an agent runs it: a subprocess whose stderr is thrown away, so every refusal must reach stdout and
// no failure may exit with the code that means "no line matched".
const SCRIPT = fileURLToPath(new URL("./retrieve-output.mjs", import.meta.url));
const run = (...args: string[]) => {
    const result = spawnSync("node", [SCRIPT, ...args], { encoding: "utf8" });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
};

let dir: string;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "retrieve-output-"));
});
afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

test("a pattern returns the matching lines, case-insensitive", () => {
    const log = join(dir, "run.log");
    writeFileSync(log, "compiling\nERROR: missing semicolon\nok\n");
    expect(run(log, "error")).toEqual({ code: 0, stdout: "ERROR: missing semicolon\n", stderr: "" });
});

test("a pattern that matches nothing says so on stdout and exits 1", () => {
    const log = join(dir, "run.log");
    writeFileSync(log, "compiling\nok\n");
    expect(run(log, "panic")).toEqual({ code: 1, stdout: `retrieve-output: no line in ${log} matches "panic"\n`, stderr: "" });
});

test("no log and an unreadable log are exit 2 with the reason on stdout", () => {
    expect(run()).toEqual({ code: 2, stdout: "usage: retrieve-output <log-file> [pattern]\n", stderr: "" });
    const missing = run(join(dir, "gone.log"));
    expect(missing.code).toBe(2);
    expect(missing.stdout).toStartWith(`retrieve-output: cannot read ${join(dir, "gone.log")}: ENOENT`);
    expect(missing.stderr).toBe("");
});
