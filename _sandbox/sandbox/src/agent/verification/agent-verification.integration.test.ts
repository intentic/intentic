import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { projectChecks } from "./agent-verification.js";

/* WHAT THE NUDGE OFFERS TO RUN, read off a real tree, because every rule it follows is about files being there
 * or not: a script defined in a manifest, a config that mentions a suite, an environment holding the binary.
 *
 * The one thing all of it protects against: naming a command the agent cannot run. A model told to run
 * `pnpm test` in a project with no such script, or `pytest` where pytest lives in a `.venv`, gets "command not
 * found" back — and reads it as the check having found something. */

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

    // `test` before `lint` because that is the preference order, and `dev` never: it is not a check, and a nudge
    // that names it would have the agent start a server and wait for it.
    expect(await projectChecks(join(root, "src/app.ts"))).toEqual(["pnpm test", "pnpm lint"]);
});

test("a manifest with no checks in it is a project that has none, not a project that was not found", async () => {
    const root = await tree({ "package.json": JSON.stringify({ name: "x" }), "src/app.ts": "" });
    // The empty list stops the walk: the nearest project answered, and it answered "nothing here".
    expect(await projectChecks(join(root, "src/app.ts"))).toEqual([]);
    const broken = await tree({ "package.json": "{ not json", "src/app.ts": "" });
    // A manifest that does not parse said nothing at all, so the walk goes past it rather than reporting none.
    expect(await projectChecks(join(broken, "src/app.ts"))).toBeUndefined();
});

test("a python project's suite is offered in the spelling that will run where the agent stands", async () => {
    const withEnvironment = await tree({
        "pyproject.toml": '[project]\nname = "svc"\n\n[dependency-groups]\ndev = ["pytest>=8"]\n',
        ".venv/bin/pytest": "#!/bin/sh\n",
        "svc/api.py": "def f():\n    return 1\n",
    });
    // The environment's own binary: `pytest` alone is not on PATH in this image, and never is in a fresh one.
    expect(await projectChecks(join(withEnvironment, "svc/api.py"))).toEqual([".venv/bin/pytest"]);

    const withoutEnvironment = await tree({
        "pyproject.toml": '[project]\nname = "svc"\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n',
        "svc/api.py": "",
    });
    // No environment yet: `uv run` is the one spelling that resolves the project's own, and the manifest it
    // needs is right there.
    expect(await projectChecks(join(withoutEnvironment, "svc/api.py"))).toEqual(["uv run pytest"]);

    const bareConfig = await tree({ "pytest.ini": "[pytest]\n", "api.py": "" });
    // A pytest.ini is evidence of a suite by existing, and with no pyproject there is nothing for `uv run` to read.
    expect(await projectChecks(join(bareConfig, "api.py"))).toEqual(["pytest"]);
});

test("a python project that never mentions a suite is not given one", async () => {
    const root = await tree({ "pyproject.toml": '[project]\nname = "svc"\nversion = "0.1.0"\n', "svc/api.py": "" });
    // The same discipline as the node side: this manifest defines no check, so the nudge asks the agent to pick
    // one rather than naming a suite that may not exist.
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

    // On an image without the python pack the binary is absent, and an absent binary is never named.
    expect(await projectChecks(join(root, "svc/api.py"))).toEqual(hasRuff ? ["uv run pytest", "ruff check ."] : ["uv run pytest"]);
});

test("the nearest project answers, and a file under no project at all gets no answer", async () => {
    const root = await tree({
        "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
        "services/api/pyproject.toml": '[project]\nname = "api"\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n',
        "services/api/api.py": "",
    });
    // The python project sits below a node one, and it is the python file's own project that is asked.
    expect(await projectChecks(join(root, "services/api/api.py"))).toEqual(["uv run pytest"]);

    const loose = await tree({ "notes/thing.py": "" });
    expect(await projectChecks(join(loose, "notes/thing.py"))).toBeUndefined();
});
