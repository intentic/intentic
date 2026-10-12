// Pins what home-dir reads as reaching for the home directory past homeDir(): `homedir(` however it is spelled, and
// never homeDir() itself or a bare import of the name.
import assert from "node:assert/strict";
import { test } from "node:test";
import { homeDirCalls } from "./lib/home-dir-calls.mjs";

test("os.homedir() and a bare homedir() are reaches, a space before the parenthesis too", () => {
    assert.deepEqual(homeDirCalls(`import os from "node:os";\nconst a = os.homedir();\nconst b = homedir ();`), [2, 3]);
    // The one that shipped (engine-env.ts, bad64385f7): a default parameter fixed at the home of startup.
    assert.deepEqual(homeDirCalls(`export const syncEngineEnv = (env: NodeJS.ProcessEnv = process.env, home: string = homedir()): void => {`), [1]);
});

test("homeDir() and an import that names homedir without calling it are not", () => {
    assert.deepEqual(homeDirCalls(`import { homeDir } from "@intentic/local-agent";\nimport { homedir } from "node:os";\nconst home = homeDir();`), []);
});
