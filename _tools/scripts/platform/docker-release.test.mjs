// Pins where docker-release.sh --prune puts the pruned tree: outside the app directory, handed to `docker build` as
// the context, and gone once the script exits, however it exits. `pnpm` and `docker` are stubs on PATH that record
// their arguments, so nothing is built or pushed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

const SCRIPT = join(import.meta.dirname, "docker-release.sh");

let root;
let app;
let runnerTemp;
let log;

// The stub pnpm writes a file into the deploy target the way `pnpm deploy` would; the stub docker records, at build
// time, what the context held, and fails the build when DOCKER_BUILD_FAILS is set.
const PNPM = `#!/usr/bin/env bash
echo "pnpm $*" >> "$STUB_LOG"
target="\${@: -1}"
mkdir -p "$target/src" && echo 'test("x", () => {});' > "$target/src/x.test.ts"
`;
const DOCKER = `#!/usr/bin/env bash
echo "docker $*" >> "$STUB_LOG"
if [ "$1" = build ]; then
    context="\${@: -1}"
    echo "context-held $(cd "$context" && find . -type f | sort | tr '\\n' ' ')" >> "$STUB_LOG"
    [ -z "\${DOCKER_BUILD_FAILS:-}" ] || exit 1
fi
`;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "docker-release-test-"));
    app = join(root, "app");
    runnerTemp = join(root, "runner-temp");
    const bin = join(root, "bin");
    log = join(root, "calls.log");
    for (const dir of [app, runnerTemp, bin]) {
        mkdirSync(dir);
    }
    writeFileSync(join(app, "package.json"), JSON.stringify({ name: "@example/app" }));
    writeFileSync(join(app, "Dockerfile"), "FROM scratch\nCOPY . /app\n");
    writeFileSync(join(bin, "pnpm"), PNPM);
    writeFileSync(join(bin, "docker"), DOCKER);
    chmodSync(join(bin, "pnpm"), 0o755);
    chmodSync(join(bin, "docker"), 0o755);
    writeFileSync(log, "");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const release = (args, env = {}) => {
    const { TURBO_HASH: _hash, GITHUB_SHA: _sha, ...inherited } = process.env;
    return spawnSync("bash", [SCRIPT, "api", ...args], {
        cwd: app,
        encoding: "utf8",
        env: {
            ...inherited,
            PATH: `${join(root, "bin")}:${process.env.PATH}`,
            STUB_LOG: log,
            RUNNER_TEMP: runnerTemp,
            REGISTRIES: "registry.example/intentic",
            TAGS: "t1",
            ...env,
        },
    });
};

const calls = () => readFileSync(log, "utf8").split("\n").filter((line) => line !== "");
const lastWord = (line) => line.slice(line.lastIndexOf(" ") + 1);

test("--prune deploys into the runner's temp root, builds from there, and leaves nothing behind", () => {
    const result = release(["--prune"]);
    assert.equal(result.status, 0, result.stderr);

    const [deploy, build, held, push] = calls();
    const tree = lastWord(deploy);
    assert.equal(deploy, `pnpm --filter=@example/app deploy --prod ${tree}`);
    assert.match(tree, new RegExp(`^${runnerTemp}/docker-release-api\\.[^/]+/tree$`, "u"));
    assert.equal(build, `docker build --provenance=false -f Dockerfile -t registry.example/intentic/api:t1 ${tree}`);
    assert.equal(held, "context-held ./src/x.test.ts ");
    assert.equal(push, "docker push registry.example/intentic/api:t1");

    assert.deepEqual(readdirSync(runnerTemp), []);
    assert.deepEqual(readdirSync(app).toSorted(), ["Dockerfile", "package.json"]);
});

test("a failed build still removes the pruned tree", () => {
    const result = release(["--prune"], { DOCKER_BUILD_FAILS: "1" });
    assert.equal(result.status, 1);
    assert.equal(calls().some((line) => line.startsWith("docker push")), false);
    assert.deepEqual(readdirSync(runnerTemp), []);
    assert.equal(existsSync(join(app, "deploy")), false);
});

test("without --prune the app directory is the context and nothing is deployed", () => {
    const result = release([]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(calls(), [
        "docker build --provenance=false -f Dockerfile -t registry.example/intentic/api:t1 .",
        "context-held ./Dockerfile ./package.json ",
        "docker push registry.example/intentic/api:t1",
    ]);
});
