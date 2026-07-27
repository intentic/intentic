import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { ManagedProcesses } from "../processes/managed-processes.js";
import { discoverProjects, installPanelKey, setupNoticeFor, setupStateOf, type ProjectSetupStatus } from "./workspace-setup.js";

const workspace = async (): Promise<string> => mkdtemp(join(tmpdir(), "setup-"));

const write = async (root: string, path: string, content = "{}"): Promise<void> => {
    const full = join(root, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
};

// Only `running` matters here; the rest of the manager is irrelevant to readiness.
const processes = (runningKeys: readonly string[] = []): ManagedProcesses =>
    ({ running: (key: string) => runningKeys.includes(key) }) as ManagedProcesses;

test("a dropped project is discovered with the manager its lockfile names", async () => {
    const root = await workspace();
    await write(root, "app/package.json");
    await write(root, "app/pnpm-lock.yaml", "");
    expect(await discoverProjects(root)).toEqual([{ dir: "app", recipe: expect.objectContaining({ manager: "pnpm", marker: "node_modules" }) }]);
});

test("the packageManager field wins over the lockfile on disk too", async () => {
    const root = await workspace();
    await write(root, "app/package.json", `{"packageManager":"yarn@4.0.0"}`);
    await write(root, "app/package-lock.json", "");
    expect((await discoverProjects(root))[0]?.recipe.manager).toBe("yarn");
});

test("a monorepo is ONE project — the walk stops at the first manifest, so members aren't installed separately", async () => {
    const root = await workspace();
    await write(root, "repo/package.json");
    await write(root, "repo/pnpm-lock.yaml", "");
    await write(root, "repo/_apps/web/package.json");
    await write(root, "repo/_apps/api/package.json");
    expect(await discoverProjects(root)).toEqual([{ dir: "repo", recipe: expect.anything() }]);
});

test("junk dirs are never descended into — a vendored manifest is not a project", async () => {
    const root = await workspace();
    await write(root, "app/node_modules/left-pad/package.json");
    await write(root, "app/dist/package.json");
    expect(await discoverProjects(root)).toEqual([]);
});

test("two unrelated dropped projects are found independently", async () => {
    const root = await workspace();
    await write(root, "api/package.json");
    await write(root, "api/yarn.lock", "");
    await write(root, "site/package.json");
    expect((await discoverProjects(root)).map((project) => [project.dir, project.recipe.manager])).toEqual([
        ["api", "yarn"],
        ["site", "npm"],
    ]);
});

const installed = async (): Promise<boolean> => true;
const absent = async (): Promise<boolean> => false;

test("the marker on disk is what separates ready from needs-setup", async () => {
    const root = await workspace();
    await write(root, "app/package.json");
    await write(root, "app/pnpm-lock.yaml", "");
    const [project] = await discoverProjects(root);
    expect(project).toBeDefined();
    expect(await setupStateOf(root, project!, processes(), installed)).toBe("needs-setup");
    await mkdir(join(root, "app/node_modules"), { recursive: true });
    expect(await setupStateOf(root, project!, processes(), installed)).toBe("ready");
});

test("a running install reads as installing even once it has created an empty node_modules", async () => {
    const root = await workspace();
    await write(root, "app/package.json");
    await write(root, "app/pnpm-lock.yaml", "");
    await mkdir(join(root, "app/node_modules"), { recursive: true });
    const [project] = await discoverProjects(root);
    expect(await setupStateOf(root, project!, processes([installPanelKey("app")]), installed)).toBe("installing");
});

test("a manager that isn't in this sandbox is `unsupported`, not an install that would fail in a terminal", async () => {
    const root = await workspace();
    await write(root, "app/package.json", `{"packageManager":"bun@1.3.14"}`);
    const [project] = await discoverProjects(root);
    // bun is deliberately not baked into the sandbox image; detection still names it, so the UI can say which
    // binary is missing rather than offering an install that would exit 127 in a terminal.
    expect(project!.recipe.manager).toBe("bun");
    expect(await setupStateOf(root, project!, processes(), absent)).toBe("unsupported");
});

test("a panel key survives as a tmux session name and can't collide with an app panel", () => {
    expect(installPanelKey("")).toBe("root--install");
    expect(installPanelKey("clients/foo")).toBe("clients_foo--install");
    expect(installPanelKey("my.project")).toBe("my_project--install");
});

const status = (over: Partial<ProjectSetupStatus>): ProjectSetupStatus =>
    ({
        dir: "app",
        recipe: { ecosystem: "node", manager: "pnpm", command: "pnpm install", evidence: "pnpm-lock.yaml", marker: "node_modules" },
        state: "needs-setup",
        ...over,
    }) as ProjectSetupStatus;

test("the agent notice names the exact command, so the model doesn't rediscover it through failing tools", () => {
    const notice = setupNoticeFor([status({})]);
    expect(notice).toContain("app: run `pnpm install` there first.");
});

test("an unsupported project tells the agent NOT to try, and names the missing binary", () => {
    const notice = setupNoticeFor([status({ state: "unsupported" })]);
    expect(notice).toContain("needs `pnpm`, which is not installed in this sandbox");
    expect(notice).toContain("Do not attempt the install");
});

test("a fully-installed workspace adds nothing to the turn", () => {
    expect(setupNoticeFor([status({ state: "ready" }), status({ dir: "other", state: "installing" })])).toBeUndefined();
    expect(setupNoticeFor([])).toBeUndefined();
});

test("the workspace root owning the manifest reads as the root, not an empty name", () => {
    expect(setupNoticeFor([status({ dir: "" })])).toContain("the workspace root: run");
});
