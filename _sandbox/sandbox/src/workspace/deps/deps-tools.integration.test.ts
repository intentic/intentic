import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unstubbed } from "@intentic/testing";
import { depsTools, type DepsToolDeps, installTool, statusTool } from "./deps-tools.js";
import type { ProjectSetupStatus, SetupState } from "../layout/workspace-setup.js";

// The tools as the model meets them: the same definitions the server mounts, called by their handlers and answered in
// text.
type CallToolResult = Awaited<ReturnType<ReturnType<typeof statusTool>["handler"]>>;
const textOf = (result: CallToolResult): string => result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
const install = async (deps: DepsToolDeps, projects: string[]): Promise<string> => textOf(await installTool(deps).handler({ projects }, {}));
const status = async (deps: DepsToolDeps): Promise<string> => textOf(await statusTool(deps).handler({}, {}));

const project = (dir: string, state: SetupState): ProjectSetupStatus => ({
    dir,
    recipe: { ecosystem: "node", manager: "pnpm", command: "pnpm install", evidence: "pnpm-lock.yaml", marker: "node_modules" },
    state,
});

// The coordinator as the tool reads it: each status() read answers the next state in `states`, then keeps the last.
const coordinator = (dir: string, initial: SetupState, states: readonly SetupState[]): DepsToolDeps["dependencies"] => {
    let read = 0;
    return unstubbed<DepsToolDeps["dependencies"]>("dependencies", {
        requestInstall: async (dirs) => ({
            projects: [project(dir, initial)],
            queued: dirs.filter((each) => each === dir && (initial === "needs-setup" || initial === "stale")),
        }),
        // The last state repeats once the list runs out, which is how an install that never finishes reads.
    status: async () => [project(dir, states[Math.min(read++, states.length - 1)] ?? initial)],
    });
};

const deps = (dependencies: DepsToolDeps["dependencies"], over: Partial<DepsToolDeps> = {}): DepsToolDeps => ({
    dependencies,
    canInstall: true,
    origin: { kind: "request", conversationId: "c1" },
    waitMs: 2_000,
    pollMs: 1,
    ...over,
});

test("install waits for the daemon's install and answers with how it went", async () => {
    const text = await install(deps(coordinator("app", "needs-setup", ["needs-setup", "installing", "installing", "ready"])), ["app"]);
    expect(text).toBe("app: installed. Its checks mean what they say now.");
});

test("an install that finished with the project still behind says so, and that it is not retried on its own", async () => {
    const text = await install(deps(coordinator("app", "needs-setup", ["installing", "needs-setup"])), ["app"]);
    expect(text).toContain("app: the daemon's install finished, but");
    expect(text).toContain("It is not retried until a manifest or lockfile changes.");
});

test("an install still running when the wait is up is reported as pending, not as done", async () => {
    const text = await install(deps(coordinator("app", "stale", ["installing"]), { waitMs: 20 }), ["app"]);
    expect(text).toContain("app: still installing after the wait.");
});

test("an isolated turn is told the main tree's install reaches it through its own layer, and what to do if not", async () => {
    const tree = await mkdtemp(join(tmpdir(), "deps-tools-"));
    const text = await install(deps(coordinator("app", "needs-setup", ["installing", "ready"]), { worktree: tree }), ["app"]);
    expect(text).toContain("app: installed in the main tree. This conversation reads it through its own layer");
    expect(text).toContain("run the project's install yourself: it writes to this conversation's own copy");
});

test("a project that exists only on the conversation's branch is named, with the command to install it privately", async () => {
    const tree = await mkdtemp(join(tmpdir(), "deps-tools-"));
    await mkdir(join(tree, "video"), { recursive: true });
    await writeFile(join(tree, "video", "package.json"), "{}");
    await writeFile(join(tree, "video", "package-lock.json"), "{}");
    const dependencies = coordinator("app", "ready", ["ready"]);
    const installed = await install(deps(dependencies, { worktree: tree }), ["video"]);
    expect(installed).toContain("video: exists only on this conversation's branch. Run `npm install` in it yourself");
    const listed = await status(deps(dependencies, { worktree: tree }));
    expect(listed).toContain("app: ready.");
    expect(listed).toContain("video: exists only on this conversation's branch.");
});

test("a name the workspace does not have is not guessed at", async () => {
    const text = await install(deps(coordinator("app", "ready", ["ready"])), ["nope"]);
    expect(text).toBe("Not installed: no project at `nope`. Call `mcp__deps__status` for the names.");
});

// The standing rule rides the tool description, paid once: it must say what the agent's own install would do here.
test("the standing rule tells the agent it may install, and where that install writes", () => {
    const dependencies = coordinator("app", "ready", ["ready"]);
    expect(statusTool(deps(dependencies, { worktree: "/history/worktrees/c1" })).description).toContain(
        "it writes to this conversation's own copy of the tree, which no other conversation reads",
    );
    expect(statusTool(deps(dependencies)).description).toContain("it runs in the main tree, one install at a time with the daemon's own");
    expect(statusTool(deps(dependencies, { canInstall: false })).description).toContain("This persona cannot install dependencies; ask the owner.");
    expect(depsTools(deps(dependencies, { canInstall: false })).map((tool) => tool.name)).toEqual(["status"]);
    expect(depsTools(deps(dependencies)).map((tool) => tool.name)).toEqual(["status", "install"]);
});
