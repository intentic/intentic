import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { ManagedProcesses } from "../processes/managed-processes.js";
import { discoverProjects, installPanelKey, type ProjectSetupStatus, SETUP_NOTICE_HEADER, setupNoticeFor, setupStateOf } from "./workspace-setup.js";

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

test("a monorepo is ONE project: the walk stops at the first manifest, so members aren't installed separately", async () => {
    const root = await workspace();
    await write(root, "repo/package.json");
    await write(root, "repo/pnpm-lock.yaml", "");
    await write(root, "repo/_editor/web/package.json");
    await write(root, "repo/_platform/api/package.json");
    expect(await discoverProjects(root)).toEqual([{ dir: "repo", recipe: expect.anything() }]);
});

test("junk dirs are never descended into: a vendored manifest is not a project", async () => {
    const root = await workspace();
    await write(root, "app/node_modules/left-pad/package.json");
    await write(root, "app/dist/package.json");
    expect(await discoverProjects(root)).toEqual([]);
});

test("the reference shelf is never descended into: a cloned reference repo must not nag for an install", async () => {
    const root = await workspace();
    await write(root, "refs/react/package.json");
    await write(root, "refs/react/yarn.lock", "");
    // A repo's OWN refs dir is not the shelf and scans normally.
    await write(root, "app/refs/package.json");
    expect((await discoverProjects(root)).map((project) => project.dir)).toEqual(["app/refs"]);
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

const stateOf = async (
    root: string,
    project: Parameters<typeof setupStateOf>[1],
    procs: ManagedProcesses,
    available: (binary: string) => Promise<boolean>,
): Promise<string> => (await setupStateOf(root, project, procs, available)).state;

test("the marker on disk is what separates ready from needs-setup", async () => {
    const root = await workspace();
    await write(root, "app/package.json");
    await write(root, "app/pnpm-lock.yaml", "");
    const [project] = await discoverProjects(root);
    expect(project).toEqual(expect.any(Object));
    expect(await stateOf(root, project!, processes(), installed)).toBe("needs-setup");
    await mkdir(join(root, "app/node_modules"), { recursive: true });
    expect(await stateOf(root, project!, processes(), installed)).toBe("ready");
});

test("a running install reads as installing even once it has created an empty node_modules", async () => {
    const root = await workspace();
    await write(root, "app/package.json");
    await write(root, "app/pnpm-lock.yaml", "");
    await mkdir(join(root, "app/node_modules"), { recursive: true });
    const [project] = await discoverProjects(root);
    expect(await stateOf(root, project!, processes([installPanelKey("app")]), installed)).toBe("installing");
});

test("a manager that isn't in this sandbox is `unsupported`, not an install that would fail in a terminal", async () => {
    const root = await workspace();
    await write(root, "app/package.json", `{"packageManager":"bun@1.3.14"}`);
    const [project] = await discoverProjects(root);
    // bun is deliberately not baked into the sandbox image; detection still names it, so the UI can say which
    // binary is missing rather than offering an install that would exit 127 in a terminal.
    expect(project!.recipe.manager).toBe("bun");
    expect(await stateOf(root, project!, processes(), absent)).toBe("unsupported");
});

/* The state the marker alone could never see: installed once, and since outgrown. This is what an agent leaves
 * behind when it adds a dependency and does not install it, and what every turn after it inherits, because an
 * isolated turn overlays the main checkout's node_modules rather than making its own. */
test("a project whose manifest has outgrown its installed tree is stale, not ready", async () => {
    const root = await workspace();
    await write(root, "app/package.json", `{"name":"app","dependencies":{"left-pad":"^1.3.0"}}`);
    await write(root, "app/pnpm-lock.yaml", "");
    await mkdir(join(root, "app/node_modules"), { recursive: true });
    const [project] = await discoverProjects(root);
    const status = await setupStateOf(root, project!, processes(), installed);
    expect(status.state).toBe("stale");
    expect(status.unresolved).toEqual([{ dir: "", names: ["left-pad"] }]);
    // Installing it is what clears the state: the same command that would have served a fresh import.
    await write(root, "app/node_modules/left-pad/package.json");
    expect(await stateOf(root, project!, processes(), installed)).toBe("ready");
});

test("a non-node project is never called stale: nothing here can read what a .venv was supposed to contain", async () => {
    const root = await workspace();
    await write(root, "app/requirements.txt", "requests==2.32.0");
    await mkdir(join(root, "app/.venv"), { recursive: true });
    const [project] = await discoverProjects(root);
    expect(project!.recipe.ecosystem).toBe("python");
    expect(await stateOf(root, project!, processes(), installed)).toBe("ready");
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
    expect(notice).toContain("app: has never been set up and needs `pnpm install`");
    expect(notice).toContain("ask the owner to install it");
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

/* The stale notice asks the turn for nothing. It exists to stop one specific waste: the model reading an
 * unresolved import as a mistake in code that is fine, and editing working source to satisfy it, so it names
 * the cause and explicitly takes the install off the table.
 *
 * It must also say WHEN the tree is fixed, and the answer is next turn. "Once it is idle" was true and useless:
 * the reconciler defers while a turn is live, so the agent reading it is the reason it cannot fire. Told to
 * wait with no end to the wait, a model stops verifying anything and reports on reasoning alone. */
test("a stale project tells the turn why an import fails, and asks it to do nothing about it", () => {
    const notice = setupNoticeFor([status({ state: "stale", unresolved: [{ dir: "", names: ["left-pad", "zod"] }] })]);
    expect(notice).toContain("app: 2 declared dependencies are not installed (left-pad, zod)");
    expect(notice).toContain("do not run an install");
    expect(notice).toContain("ready on the NEXT turn, not this one");
    // The wait has to end somewhere the agent can act on. A promise keyed to the workspace going idle is keyed
    // to the reader stopping, which is the one thing it cannot observe.
    expect(notice).not.toContain("once it is idle");
    // Never the fresh-import wording: this project HAS been set up, and saying otherwise sends the model looking
    // for a first-run step that already happened.
    expect(notice).not.toContain(SETUP_NOTICE_HEADER);
});

test("stale and never-installed projects can both be true at once, and each gets its own paragraph", () => {
    const notice = setupNoticeFor([status({ dir: "fresh" }), status({ dir: "drifted", state: "stale", unresolved: [{ dir: "", names: ["vue"] }] })]);
    expect(notice).toContain("fresh: has never been set up and needs `pnpm install`");
    expect(notice).toContain("drifted: 1 declared dependencies are not installed (vue)");
});

test("the workspace root owning the manifest reads as the root, not an empty name", () => {
    expect(setupNoticeFor([status({ dir: "" })])).toContain("the workspace root: has never been set up");
});
