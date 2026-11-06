import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// Each fixture is a check as run.mjs would load it: a module whose top level is the whole run. They run one after another
// in a process of their own, as run.mjs runs them, since node:test's own handlers would claim a crash a check throws.
const dir = mkdtempSync(join(tmpdir(), "in-process-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let fixtures = 0;
const check = (source) => {
    fixtures += 1;
    const file = join(dir, `check-${fixtures}.mjs`);
    writeFileSync(file, source);
    return file;
};
const runner = new URL("./in-process.mjs", import.meta.url).href;
const runAll = (...files) => {
    const driver = check(`
        import { runInProcess } from ${JSON.stringify(runner)};
        const answers = [];
        for (const file of ${JSON.stringify(files)}) {
            answers.push({ ...(await runInProcess(file, ["--paths", "a.ts,b.vue"])), exitCode: process.exitCode });
        }
        console.log(JSON.stringify(answers));
    `);
    return JSON.parse(execFileSync(process.execPath, [driver], { encoding: "utf8" }));
};

test("a check answers with its own streams and process.exitCode, and sees a child's argv", () => {
    const file = check(`console.log("vouched", JSON.stringify(process.argv.slice(1))); console.error("a problem"); process.exitCode = 1;`);
    assert.deepEqual(runAll(file), [{ code: 1, stdout: `vouched ${JSON.stringify([file, "--paths", "a.ts,b.vue"])}\n`, stderr: "a problem\n" }]);
});

test("process.exit ends the check where it is called, not the process, and the next check starts clean", () => {
    const exits = check(`console.error("could not measure"); process.exit(2); console.error("never");`);
    const exitsWithCode = check(`process.exitCode = 1; console.error("found"); process.exit();`);
    const fine = check(`console.log("fine");`);
    assert.deepEqual(runAll(exits, exitsWithCode, fine), [
        { code: 2, stdout: "", stderr: "could not measure\n" },
        { code: 1, stdout: "", stderr: "found\n" },
        { code: 0, stdout: "fine\n", stderr: "" },
    ]);
});

test("an exit from a callback ends a check that would otherwise wait forever, and its late writes are dropped", () => {
    const stuck = check(`
        setTimeout(() => { console.error("gave up"); process.exit(2); }, 5);
        setTimeout(() => console.error("after the exit"), 20);
        await new Promise(() => {});
    `);
    // The second timer fires during the next check, and must not land in its report.
    const next = check(`await new Promise((resolve) => setTimeout(resolve, 40)); console.log("next");`);
    assert.deepEqual(runAll(stuck, next), [
        { code: 2, stdout: "", stderr: "gave up\n" },
        { code: 0, stdout: "next\n", stderr: "" },
    ]);
});

test("an exit inside a promise awaited only later ends the check there, as a child's would", () => {
    const file = check(`
        const pending = Promise.resolve().then(() => process.exit(2));
        await new Promise((resolve) => setTimeout(resolve, 20));
        console.log("too late");
        await pending;
    `);
    assert.deepEqual(runAll(file), [{ code: 2, stdout: "", stderr: "" }]);
});

test("a throw, at the top or in a callback, is a crash: exit 1 with the error", () => {
    const top = check(`console.log("partial"); throw new Error("top-level bug");`);
    const late = check(`setTimeout(() => { throw new Error("callback bug"); }, 5); await new Promise(() => {});`);
    const [atTop, inCallback] = runAll(top, late);
    assert.deepEqual([atTop.code, atTop.stdout, inCallback.code, inCallback.stdout], [1, "partial\n", 1, ""]);
    assert.match(atTop.stderr, /^Error: top-level bug\n {4}at /u);
    assert.match(inCallback.stderr, /^Error: callback bug\n {4}at /u);
});
