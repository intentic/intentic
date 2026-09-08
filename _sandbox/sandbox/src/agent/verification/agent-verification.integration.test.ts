import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { projectChecks } from "./agent-verification.js";

// What the nudge offers to run, read off a real tree: every rule is about files being there or not (a manifest script,
// a config, an environment binary). Guards against naming a command the agent cannot run.

const tempDirs: string[] = [];
afterAll(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

const tree = async (files: Readonly<Record<string, string>>): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "checks-"));
    tempDirs.push(root);
    for (const [path, content] of Object.entries(files)) {
        await mkdir(join(root, path, ".."), { recursive: true });
        await writeFile(join(root, path), content);
    }
    return root;
};

test("a node project offers the check scripts it actually defines, in preference order, and nothing else", async () => {
    const root = await tree({
        "package.json": JSON.stringify({ scripts: { dev: "vite", lint: "oxlint", test: "vitest run" } }),
        "src/app.ts": "export const a = 1;\n",
    });

    // `test` before `lint` is the preference order; `dev` is never offered since running it just starts a server.
    expect(await projectChecks(join(root, "src/app.ts"))).toEqual(["pnpm test", "pnpm lint"]);
});

test("a manifest with no checks in it is a project that has none, not a project that was not found", async () => {
    const root = await tree({ "package.json": JSON.stringify({ name: "x" }), "src/app.ts": "" });
    // The empty list means the nearest project answered and said "nothing here", not that none was found.
    expect(await projectChecks(join(root, "src/app.ts"))).toEqual([]);
    const broken = await tree({ "package.json": "{ not json", "src/app.ts": "" });
    // A manifest that fails to parse says nothing at all, so the walk continues past it rather than reporting none.
    expect(await projectChecks(join(broken, "src/app.ts"))).toBeUndefined();
});

test("a python project's suite is offered in the spelling that will run where the agent stands", async () => {
    const withEnvironment = await tree({
        "pyproject.toml": '[project]\nname = "svc"\n\n[dependency-groups]\ndev = ["pytest>=8"]\n',
        ".venv/bin/pytest": "#!/bin/sh\n",
        "svc/api.py": "def f():\n    return 1\n",
    });
    // The environment's own binary: bare `pytest` is not on PATH in this image, nor in a fresh one.
    expect(await projectChecks(join(withEnvironment, "svc/api.py"))).toEqual([".venv/bin/pytest"]);

    const withoutEnvironment = await tree({
        "pyproject.toml": '[project]\nname = "svc"\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n',
        "svc/api.py": "",
    });
    // No environment yet: `uv run` resolves the project's own pytest, and the manifest it needs is right there.
    expect(await projectChecks(join(withoutEnvironment, "svc/api.py"))).toEqual(["uv run pytest"]);

    const bareConfig = await tree({ "pytest.ini": "[pytest]\n", "api.py": "" });
    // pytest.ini alone is evidence of a suite; with no pyproject there is nothing for `uv run` to read.
    expect(await projectChecks(join(bareConfig, "api.py"))).toEqual(["pytest"]);
});

test("a python project that never mentions a suite is not given one", async () => {
    const root = await tree({ "pyproject.toml": '[project]\nname = "svc"\nversion = "0.1.0"\n', "svc/api.py": "" });
    // Same discipline as the node side: an empty manifest means no check offered, not a guessed suite.
    expect(await projectChecks(join(root, "svc/api.py"))).toEqual([]);
});

test("ruff is offered only where the project configures it and this image carries it", async () => {
    const root = await tree({
        "pyproject.toml": '[project]\nname = "svc"\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n\n[tool.ruff]\nline-length = 120\n',
        "svc/api.py": "",
    });
    const hasRuff = ((): boolean => {
        try {
            execFileSync("ruff", ["--version"], { stdio: "ignore", timeout: 30_000 });
            return true;
        } catch {
            return false;
        }
    })();

    // Without the python pack the ruff binary is absent, so it is never named.
    expect(await projectChecks(join(root, "svc/api.py"))).toEqual(hasRuff ? ["uv run pytest", "ruff check ."] : ["uv run pytest"]);
});

test("the nearest project answers, and a file under no project at all gets no answer", async () => {
    const root = await tree({
        "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
        "services/api/pyproject.toml": '[project]\nname = "api"\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n',
        "services/api/api.py": "",
    });
    // The python project nests under a node one; it is the file's own nearest project that answers.
    expect(await projectChecks(join(root, "services/api/api.py"))).toEqual(["uv run pytest"]);

    const loose = await tree({ "notes/thing.py": "" });
    expect(await projectChecks(join(loose, "notes/thing.py"))).toBeUndefined();
});
