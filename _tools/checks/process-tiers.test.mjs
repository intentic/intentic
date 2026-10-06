// Pins what process-tiers reads as a process started by hand: a child_process starter called or promisified, followed
// through an alias or a namespace, and not a type import, a method of the same name, prose, or an excused site.
import assert from "node:assert/strict";
import { test } from "node:test";
import { processCalls } from "./lib/process-calls.mjs";

test("a promisified execFile is one finding, and a direct call is one", () => {
    const code = [
        `import { execFile, spawn } from "node:child_process";`,
        `const run = promisify(execFile);`,
        `await run("git", ["status"]);`,
        `const child = spawn("sh", ["-c", line]);`,
    ].join(`\n`);
    assert.deepEqual(processCalls(code), [
        { line: 2, what: `promisify(execFile)` },
        { line: 4, what: `spawn()` },
    ]);
});

test("an alias and a namespace are followed, the bare module name too", () => {
    assert.deepEqual(processCalls(`import { spawn as nodeSpawn } from "child_process";\nnodeSpawn("x", []);`), [{ line: 2, what: `spawn()` }]);
    assert.deepEqual(processCalls(`import * as cp from "node:child_process";\ncp.execSync("ls");\ncp.ChildProcess;`), [{ line: 2, what: `execSync()` }]);
});

test("a type import, a method of the same name, a local of another module and prose are not uses", () => {
    assert.deepEqual(processCalls(`import type { ChildProcess } from "node:child_process";\nspawn("x");`), []);
    assert.deepEqual(processCalls(`import { type ChildProcess, spawn } from "node:child_process";\nconst c: ChildProcess = pool.spawn("x");`), []);
    assert.deepEqual(processCalls(`import { exec } from "@intentic/base/git";\nawait exec("git", []);`), []);
    assert.deepEqual(processCalls(`import { spawn } from "node:child_process";\n// spawn("x") would leave its children\n/* spawn("y") */`), []);
});

test("a site that says why is excused, on its line or in the comment block above it, and only with a reason", () => {
    const head = `import { spawn } from "node:child_process";\n`;
    assert.deepEqual(processCalls(`${head}spawn("x"); // allow(process-tiers): streamed, killed by its own runner`), []);
    assert.deepEqual(processCalls(`${head}// allow(process-tiers): a browser the owner watches, supervised elsewhere\nspawn("x");`), []);
    assert.deepEqual(processCalls(`${head}// allow(process-tiers):\nspawn("x");`), [{ line: 3, what: `spawn()` }]);
});
