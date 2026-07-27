import { expect, test } from "vitest";
import { detectProjects, managerFromPackageJson, recipeFor } from "./index.js";

test("the lockfile names the manager, most specific first", () => {
    expect(recipeFor(["package.json", "pnpm-lock.yaml"])?.manager).toBe("pnpm");
    expect(recipeFor(["package.json", "yarn.lock"])?.manager).toBe("yarn");
    expect(recipeFor(["package.json", "package-lock.json"])?.manager).toBe("npm");
    expect(recipeFor(["package.json", "bun.lockb"])?.manager).toBe("bun");
    // A half-finished migration carrying both resolves rather than asking the user to arbitrate.
    expect(recipeFor(["package.json", "pnpm-lock.yaml", "package-lock.json"])?.manager).toBe("pnpm");
});

test("a package.json with no lockfile falls back to npm and SAYS so, so the guess is correctable", () => {
    const recipe = recipeFor(["package.json"]);
    expect(recipe?.manager).toBe("npm");
    expect(recipe?.evidence).toBe("package.json (no lockfile)");
});

test("the packageManager field beats the lockfile — it's what the project declares, not what someone last ran", () => {
    expect(recipeFor(["package.json", "package-lock.json"], "pnpm")?.manager).toBe("pnpm");
    expect(recipeFor(["package.json", "package-lock.json"], "pnpm")?.evidence).toBe("the packageManager field");
});

test("an unrecognized packageManager is ignored, not trusted — its name becomes a shell command", () => {
    expect(managerFromPackageJson(`{"packageManager":"pnpm@11.13.1+sha512.abc"}`)).toBe("pnpm");
    expect(managerFromPackageJson(`{"packageManager":"yarn@4.0.0"}`)).toBe("yarn");
    expect(managerFromPackageJson(`{"packageManager":"rm -rf /"}`)).toBeUndefined();
    expect(managerFromPackageJson(`{"packageManager":"@evil/pm@1"}`)).toBeUndefined();
    expect(managerFromPackageJson(`{"packageManager":42}`)).toBeUndefined();
    expect(managerFromPackageJson(`{}`)).toBeUndefined();
    expect(managerFromPackageJson(`not json`)).toBeUndefined();
    // A lockfile-detected repo whose field is junk still installs — the field is an override, never a gate.
    expect(recipeFor(["package.json", "pnpm-lock.yaml"], undefined)?.manager).toBe("pnpm");
});

test("python is detected by lockfile, and requirements.txt gets the portable stdlib answer", () => {
    expect(recipeFor(["uv.lock", "pyproject.toml"])).toMatchObject({ ecosystem: "python", manager: "uv", command: "uv sync" });
    expect(recipeFor(["poetry.lock", "pyproject.toml"])?.manager).toBe("poetry");
    expect(recipeFor(["requirements.txt"])).toMatchObject({ manager: "python3", marker: ".venv" });
    expect(recipeFor(["pyproject.toml"])?.manager).toBe("uv");
});

test("node wins over python when a repo carries both — package.json is the one the sandbox can act on", () => {
    expect(recipeFor(["package.json", "pnpm-lock.yaml", "requirements.txt"])?.ecosystem).toBe("node");
});

test("a directory with no manifest has no recipe", () => {
    expect(recipeFor(["README.md", "src"])).toBeUndefined();
    expect(recipeFor([])).toBeUndefined();
});

test("a monorepo installs ONCE from its root — descending would propose N redundant installs of one tree", () => {
    const projects = detectProjects([
        "app/package.json",
        "app/pnpm-lock.yaml",
        "app/pnpm-workspace.yaml",
        "app/_apps/web/package.json",
        "app/_apps/api/package.json",
        "app/_libs/ui/package.json",
    ]);
    expect(projects).toEqual([{ dir: "app", recipe: expect.objectContaining({ manager: "pnpm" }) }]);
});

test("two unrelated projects dropped side by side each get their own recipe", () => {
    const projects = detectProjects(["api/package.json", "api/yarn.lock", "worker/pyproject.toml", "worker/uv.lock"]);
    expect(projects.map((project) => [project.dir, project.recipe.manager])).toEqual([
        ["api", "yarn"],
        ["worker", "uv"],
    ]);
});

test('a manifest at the drop root itself is dir ""', () => {
    expect(detectProjects(["package.json", "pnpm-lock.yaml", "src/main.ts"])).toEqual([
        { dir: "", recipe: expect.objectContaining({ manager: "pnpm" }) },
    ]);
});

test("the root manifest suppresses every nested one, whatever order the concurrent drop walk emitted", () => {
    const nestedFirst = detectProjects(["app/_apps/web/package.json", "app/package.json"]);
    expect(nestedFirst).toEqual([{ dir: "app", recipe: expect.anything() }]);
});

test("packageManagerFields are applied per project dir", () => {
    const fields = new Map([["api", "pnpm"]]);
    const projects = detectProjects(["api/package.json", "api/package-lock.json", "web/package.json", "web/package-lock.json"], fields);
    expect(projects.map((project) => [project.dir, project.recipe.manager])).toEqual([
        ["api", "pnpm"],
        ["web", "npm"],
    ]);
});
