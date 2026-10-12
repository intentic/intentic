// Pins what the turn check says about the packages a change reaches (reach-typecheck.mjs): a dependent that typechecked
// clean before the change and fails now is the change's, one with no such record is never run and never charged, since
// it may be main's own failure, and the budget ends the reading without accusing anyone of what it did not reach.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { dependentsOf, errorLines, reachTypecheck, runOrder } from "./reach-typecheck.mjs";

// contract <- web <- demo, contract <- daemon; ui is nobody's.
const graph = {
    packages: new Map([
        ["@x/contract", { name: "@x/contract", dir: "_shared/contract", deps: new Set(), assetOnly: false }],
        ["@x/web", { name: "@x/web", dir: "_editor/web", deps: new Set(["@x/contract"]), assetOnly: false }],
        ["@x/demo", { name: "@x/demo", dir: "_site/demo", deps: new Set(["@x/web"]), assetOnly: false }],
        ["@x/daemon", { name: "@x/daemon", dir: "_sandbox/daemon", deps: new Set(["@x/contract"]), assetOnly: false }],
        ["@x/ui", { name: "@x/ui", dir: "_editor/ui", deps: new Set(), assetOnly: false }],
    ]),
    byDir: [
        ["_sandbox/daemon", "@x/daemon"],
        ["_shared/contract", "@x/contract"],
        ["_editor/web", "@x/web"],
        ["_site/demo", "@x/demo"],
        ["_editor/ui", "@x/ui"],
    ],
    dependents: new Map([
        ["@x/contract", new Set(["@x/web", "@x/daemon"])],
        ["@x/web", new Set(["@x/demo"])],
    ]),
};

const task = (name, directory, command = "bun check") => ({ package: name, directory, command, hash: `${name}-hash` });
const TASKS = new Map([
    ["@x/web", task("@x/web", "_editor/web", "vue-tsc --noEmit")],
    ["@x/demo", task("@x/demo", "_site/demo", "vue-tsc --noEmit")],
    ["@x/daemon", task("@x/daemon", "_sandbox/daemon")],
]);

// A checkout that passes reach-typecheck's install test: a turbo binary, and a lockfile node_modules was installed from.
const installed = () => {
    const root = mkdtempSync(join(tmpdir(), "reach-typecheck-"));
    for (const [path, text] of [
        ["pnpm-lock.yaml", "lockfileVersion: '9.0'\n"],
        ["node_modules/.pnpm/lock.yaml", "lockfileVersion: '9.0'\n"],
        ["node_modules/.bin/turbo", ""],
    ]) {
        const file = join(root, path);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, text);
    }
    return root;
};

const reach = (root, over) => {
    let clock = 0;
    return reachTypecheck({
        root,
        base: "base",
        changed: ["_shared/contract/src/index.ts"],
        deadline: 1_000,
        graph,
        fleet: { url: "https://cache.example", token: "t", team: "intentic" },
        concurrency: 1,
        now: () => clock,
        plan: () => TASKS,
        passed: async () => new Set(TASKS.keys()),
        typecheck: async () => {
            clock += 10;
            return { status: "passed", output: "" };
        },
        ...over,
    });
};

test("what a change reaches is every package depending on what it touched, nearest first, the change's own left out", () => {
    assert.deepEqual(dependentsOf(graph, ["_shared/contract/src/index.ts"]), ["@x/daemon", "@x/web", "@x/demo"]);
    assert.deepEqual(dependentsOf(graph, ["_editor/ui/src/index.ts"]), []);
    // A root file is no package's source: the lockfile alone reaches nothing here, which is CI's verify groups' to read.
    assert.deepEqual(dependentsOf(graph, ["pnpm-lock.yaml"]), []);
});

test("a fast compiler's package runs before vue-tsc's, the nearest first within each", () => {
    assert.deepEqual(runOrder(["@x/web", "@x/demo", "@x/daemon"], TASKS), ["@x/daemon", "@x/web", "@x/demo"]);
});

test("an error is quoted at the path the workspace knows, and a crash by its last words", () => {
    const output = "src/unserved.ts(380,3): error TS1360: Type '{…}' does not satisfy the expected type.\nFound 1 error.\n";
    assert.deepEqual(errorLines(output, "_site/demo"), ["_site/demo/src/unserved.ts(380,3): error TS1360: Type '{…}' does not satisfy the expected type."]);
    assert.deepEqual(errorLines("\nsh: vue-tsc: not found\n", "_site/demo"), ["sh: vue-tsc: not found"]);
});

test("a dependent that typechecked clean before and fails now is the change's, quoted under its name", async () => {
    const root = installed();
    try {
        const said = await reach(root, {
            typecheck: async (one) =>
                one.package === "@x/demo"
                    ? { status: "failed", output: "src/unserved.ts(380,3): error TS1360: missing POST /system/enroll/code\n" }
                    : { status: "passed", output: "" },
        });
        assert.equal(said.code, 1);
        assert.deepEqual(said.out.slice(0, 1), ["✗ typecheck @x/demo: _site/demo/src/unserved.ts(380,3): error TS1360: missing POST /system/enroll/code"]);
        assert.match(said.out.at(-1), /1 package\(s\) that depend on what this change edits typechecked clean before it and fail now/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a dependent with no record of a clean typecheck is never run, and so never charged: main may fail it already", async () => {
    const root = installed();
    const ran = [];
    try {
        const said = await reach(root, {
            passed: async () => new Set(["@x/daemon"]),
            typecheck: async (one) => {
                ran.push(one.package);
                return { status: "failed", output: "error TS2307: nope" };
            },
        });
        assert.deepEqual(ran, ["@x/daemon"]);
        assert.equal(said.out.filter((line) => line.startsWith("✗")).length, 1);
        assert.ok(said.notes.some((line) => line.startsWith("@x/web, @x/demo: no record of a clean typecheck")));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("the budget ends the reading and says what it left, charging nothing it did not reach", async () => {
    const root = installed();
    let clock = 0;
    try {
        const said = await reach(root, {
            now: () => clock,
            typecheck: async () => {
                clock += 600;
                return { status: "passed", output: "" };
            },
        });
        assert.equal(said.code, 0);
        assert.ok(said.notes.some((line) => line === "stopped at the typecheck budget with @x/demo unread; CI typechecks them"));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("without an install from this lockfile nothing is typechecked, and the run says why rather than failing", async () => {
    const root = mkdtempSync(join(tmpdir(), "reach-typecheck-bare-"));
    try {
        const said = await reach(root, {});
        assert.deepEqual(said.out, []);
        assert.equal(said.code, 0);
        assert.match(said.notes[0], /not installed from this pnpm-lock.yaml/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("without the fleet's cache, where CI's records live, nothing is planned and the turn is told why", async () => {
    let planned = false;
    const said = await reach(installed(), {
        fleet: undefined,
        plan: () => {
            planned = true;
            return TASKS;
        },
    });
    assert.equal(planned, false);
    assert.equal(said.code, 0);
    assert.match(said.notes[0], /no turbo-cache card is connected/);
});
