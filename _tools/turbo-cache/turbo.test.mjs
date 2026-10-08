// THE WHOLE PATH WITH THE REAL TURBO, on a fixture monorepo: a sandbox's run uploads through the server, CI's import
// takes what its own dry run attributes to output-less tasks, and CI's turbo, reading nothing but its local cache
// directory, replays those tasks as hits. The build's entry the sandbox tried to upload never arrives, so CI builds.
// Skipped where turbo is not installed (a checkout before `pnpm install`), since turbo is the thing under test.
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { repoRoot } from "../constants/src/node.mjs";
import { dryRunTasks, turboBin } from "./dry-run.mjs";
import { importResults } from "./import.mjs";
import { createCacheServer } from "./server.mjs";

const TURBO = turboBin(repoRoot(import.meta.url));
const TOKEN = "fixture-token-of-some-length";

let root;
let fixture;
let ciDir;
let sandboxDir;
let server;
let api;

const write = (path, text) => {
    mkdirSync(join(fixture, path, ".."), { recursive: true });
    writeFileSync(join(fixture, path), text);
};

// Turbo with none of the ambient TURBO_ settings, so the run is the one the test describes. Asynchronous on purpose: the
// server answering it lives in this process, and a synchronous spawn would leave it deaf until turbo gave up.
const turbo = async (args, extra = {}) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("TURBO_")));
    const { stdout } = await promisify(execFile)(TURBO, args, { cwd: fixture, env: { ...env, TURBO_TELEMETRY_DISABLED: "1", ...extra } });
    return stdout;
};
const statusOf = (output, taskId) => new RegExp(`^${taskId}: cache (hit|miss)`, "m").exec(output)?.[1];

before(async () => {
    if (TURBO === undefined) {
        return;
    }
    root = mkdtempSync(join(tmpdir(), "turbo-cache-e2e-"));
    fixture = join(root, "repo");
    ciDir = join(root, "ci");
    sandboxDir = join(root, "sandbox");
    write("package.json", JSON.stringify({ name: "fixture", private: true, packageManager: "pnpm@10.0.0" }));
    write("pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
    write("pnpm-lock.yaml", 'lockfileVersion: "9.0"\nimporters:\n  .: {}\n  packages/a: {}\n');
    write(".gitignore", "node_modules\n.turbo\ndist\n");
    write("turbo.json", JSON.stringify({ tasks: { typecheck: { outputs: [] }, build: { outputs: ["dist/**"] } }, remoteCache: { enabled: true } }));
    write(
        "packages/a/package.json",
        JSON.stringify({ name: "a", version: "1.0.0", scripts: { typecheck: "echo typechecked", build: "mkdir -p dist && echo built > dist/out.txt" } }),
    );
    for (const args of [["init", "-q"], ["add", "-A"], ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "fixture"]]) {
        assert.equal(spawnSync("git", args, { cwd: fixture }).status, 0);
    }
    server = createCacheServer({ token: TOKEN, readDirs: [ciDir], writeDir: sandboxDir });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    api = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
    server?.close();
    if (root !== undefined) {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a sandbox's typecheck becomes CI's cache hit; its build never does", { skip: TURBO === undefined && "turbo is not installed" }, async () => {
    // The sandbox: no local cache, everything through the server.
    const sandboxRun = await turbo(["run", "typecheck", "build", "--cache=local:,remote:rw"], { TURBO_API: api, TURBO_TOKEN: TOKEN, TURBO_TEAM: "fleet" });
    assert.equal(statusOf(sandboxRun, "a:typecheck"), "miss");
    const tasks = dryRunTasks(fixture, ["run", "typecheck", "build"], { bin: TURBO, env: { ...process.env, TURBO_TELEMETRY_DISABLED: "1" } });
    const hashOf = (taskId) => tasks.find((each) => each.taskId === taskId).hash;
    const kept = readdirSync(sandboxDir);
    assert.ok(kept.includes(`${hashOf("a#typecheck")}.tar.zst`), kept.join(", "));
    assert.ok(!kept.some((name) => name.startsWith(hashOf("a#build"))), "the build's upload was refused");

    // CI: import against its own dry run, then a turbo that reads only its local directory.
    const imported = importResults(tasks, sandboxDir, ciDir);
    assert.deepEqual(imported.imported, ["a#typecheck"]);
    rmSync(join(fixture, "packages/a/.turbo"), { recursive: true, force: true });
    const ciRun = await turbo(["run", "typecheck", "build", "--cache=local:rw,remote:"], { TURBO_CACHE_DIR: ciDir });
    assert.equal(statusOf(ciRun, "a:typecheck"), "hit");
    assert.equal(statusOf(ciRun, "a:build"), "miss");
});
