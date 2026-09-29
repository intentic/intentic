import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { parkedCards } from "../../conversations/actor/parked-cards.js";
import type { IsolationPlan } from "../../conversations/worktrees/isolation.js";
import { opt } from "../../opt.js";
import { memoryFleet } from "../../testing.js";
import {
    createInstallGrants,
    decideProjectInstall,
    detachMirrors,
    installRootOf,
    type InstallPlacement,
    type ProjectInstallGateOptions,
} from "./project-installs.js";

const git = async (cwd: string, ...args: string[]): Promise<string> => (await promisify(execFile)("git", ["-C", cwd, ...args])).stdout;

// A conversation's root worktree: a real repo with no ignore rules of its own, the way this workspace's root is.
const worktree = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "project-installs-"));
    await git(dir, "init", "-q");
    return dir;
};

// The namespace view: the turn names its tree `/work`, the daemon reads the worktree behind it.
const planOf = (tree: string, over: Partial<IsolationPlan> = {}): IsolationPlan => ({
    worktree: tree,
    root: "/work",
    mirrors: [],
    overlays: join(tree, ".overlays"),
    fence: undefined,
    ...over,
});

const cards = parkedCards(memoryFleet().conversations);

const options = (placement: InstallPlacement, over: Partial<ProjectInstallGateOptions> = {}): ProjectInstallGateOptions & { events: AgentEvent[] } => {
    const events: AgentEvent[] = [];
    return {
        placement,
        mode: "automatic",
        canInstall: true,
        conversationId: `c-${Math.random().toString(36).slice(2)}`,
        grants: createInstallGrants(),
        cards,
        push: (event) => events.push(event),
        signal: new AbortController().signal,
        unattended: false,
        events,
        ...over,
    };
};

const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

type PermissionAsk = Extract<AgentEvent, { kind: "permission" }>;

// The one card a consult raised, once it has had a tick to raise it.
const cardOf = (events: readonly AgentEvent[]): PermissionAsk | undefined =>
    events.find((event): event is PermissionAsk => event.kind === "permission");

const answer = (events: readonly AgentEvent[], decision: "once" | "always" | "deny", feedback?: string): string =>
    cards.resolve({ kind: "permission", requestId: cardOf(events)?.requestId ?? "", decision, ...opt("feedback", feedback) }) === "settled"
        ? "settled"
        : "not settled";

const ignored = async (cwd: string, path: string): Promise<boolean> =>
    git(cwd, "check-ignore", "-q", "--", path).then(
        () => true,
        () => false,
    );

test("a project the branch created keeps its fresh node_modules out of the land, workspace packages included", async () => {
    const tree = await worktree();
    await writeFile(join(tree, "README.md"), "root\n");
    await mkdir(join(tree, "video"), { recursive: true });
    await writeFile(join(tree, "video", "package.json"), "{}");
    const verdict = await decideProjectInstall("npm install remotion", [{ dir: "/work/video", ecosystem: "node" }], options({ kind: "private", plan: planOf(tree) }));
    expect(verdict).toMatchObject({ allow: true, unprepared: [] });
    expect(await ignored(tree, "video/node_modules/")).toBe(true);
    expect(await ignored(tree, "video/packages/scenes/node_modules/")).toBe(true);
    // Anchored to the project: another project's install directory is not swept up with it.
    expect(await ignored(tree, "other/node_modules/")).toBe(false);
    await mkdir(join(tree, "video", "node_modules", "remotion"), { recursive: true });
    await writeFile(join(tree, "video", "node_modules", "remotion", "index.js"), "");
    expect(await git(tree, "status", "--porcelain", "--untracked-files=all")).not.toContain("node_modules");
});

test("a directory the same line creates is excluded before it exists", async () => {
    const tree = await worktree();
    await decideProjectInstall(
        "mkdir -p app && cd app && npm init -y && npm install zod",
        [{ dir: "/work/app", ecosystem: "node" }],
        options({ kind: "private", plan: planOf(tree) }),
    );
    expect(await ignored(tree, "app/node_modules/")).toBe(true);
});

test("a project whose own .gitignore already covers it gets no exclude line", async () => {
    const tree = await worktree();
    await mkdir(join(tree, "web"), { recursive: true });
    await writeFile(join(tree, "web", ".gitignore"), "node_modules/\n");
    await writeFile(join(tree, "web", "package.json"), "{}");
    await decideProjectInstall("pnpm add zod", [{ dir: "/work/web", ecosystem: "node" }], options({ kind: "private", plan: planOf(tree) }));
    const exclude = await readFile(join(tree, ".git", "info", "exclude"), "utf8");
    expect(exclude).not.toContain("/web/");
});

test("a python project's virtualenv is kept out of the land at the project, not below it", async () => {
    const tree = await worktree();
    await mkdir(join(tree, "svc"), { recursive: true });
    await writeFile(join(tree, "svc", "pyproject.toml"), "[project]\nname = 'svc'\n");
    await decideProjectInstall("uv sync", [{ dir: "/work/svc", ecosystem: "python" }], options({ kind: "private", plan: planOf(tree) }));
    expect(await readFile(join(tree, ".git", "info", "exclude"), "utf8")).toContain("/svc/.venv/");
});

test("an install outside the conversation's tree prepares nothing and still runs", async () => {
    const tree = await worktree();
    const verdict = await decideProjectInstall("npm install", [{ dir: "/tmp/scratch", ecosystem: "node" }], options({ kind: "private", plan: planOf(tree) }));
    expect(verdict).toMatchObject({ allow: true, unprepared: [] });
});

test("the install root is the nearest lockfile, since pnpm installs a whole workspace from any package in it", async () => {
    const tree = await worktree();
    await mkdir(join(tree, "mono", "packages", "a"), { recursive: true });
    await writeFile(join(tree, "mono", "pnpm-workspace.yaml"), "packages: ['packages/*']\n");
    await writeFile(join(tree, "mono", "packages", "a", "package.json"), "{}");
    expect(await installRootOf(join(tree, "mono", "packages", "a"), tree)).toBe(join(tree, "mono"));
    // No lockfile anywhere up to the ceiling: the nearest manifest.
    await mkdir(join(tree, "solo", "src"), { recursive: true });
    await writeFile(join(tree, "solo", "package.json"), "{}");
    expect(await installRootOf(join(tree, "solo", "src"), tree)).toBe(join(tree, "solo"));
});

// State the mode: no namespace, so the worktree's node_modules are links into the main tree.
test("without a namespace, the links under the install root become the worktree's own directories first", async () => {
    const main = await mkdtemp(join(tmpdir(), "project-installs-main-"));
    await mkdir(join(main, "app", "node_modules", "left-pad"), { recursive: true });
    await mkdir(join(main, "lib", "node_modules"), { recursive: true });
    const tree = await worktree();
    await mkdir(join(tree, "app"), { recursive: true });
    await mkdir(join(tree, "lib"), { recursive: true });
    await writeFile(join(tree, "app", "package.json"), "{}");
    await symlink(join(main, "app", "node_modules"), join(tree, "app", "node_modules"), "dir");
    await symlink(join(main, "lib", "node_modules"), join(tree, "lib", "node_modules"), "dir");
    const plan = planOf(tree, { root: main, mirrors: ["app/node_modules", "lib/node_modules"] });
    expect(await detachMirrors(plan, join(tree, "app"))).toEqual(["app/node_modules"]);
    expect((await lstat(join(tree, "app", "node_modules"))).isSymbolicLink()).toBe(false);
    // The main tree's own install is untouched, and a link outside the install root stays a link.
    expect((await lstat(join(main, "app", "node_modules", "left-pad"))).isDirectory()).toBe(true);
    expect((await lstat(join(tree, "lib", "node_modules"))).isSymbolicLink()).toBe(true);
});

describe("the owner's setting", () => {
    const shared: InstallPlacement = { kind: "shared" };

    test("never refuses, and says the manifest change still installs at the land", async () => {
        const verdict = await decideProjectInstall("pnpm add zod", [{ dir: "/work", ecosystem: "node" }], options(shared, { mode: "never" }));
        expect(verdict).toMatchObject({ allow: false, reason: expect.stringContaining("installs when the owner lands the work") });
    });

    test("a persona without the power to change the workspace is refused whatever the setting", async () => {
        const verdict = await decideProjectInstall("pnpm add zod", [{ dir: "/work", ecosystem: "node" }], options(shared, { canInstall: false }));
        expect(verdict).toMatchObject({ allow: false, reason: expect.stringContaining("ask the owner") });
    });

    test("ask parks one card; allowing it once runs this install and asks again next time", async () => {
        const gate = options(shared, { mode: "ask" });
        const pending = decideProjectInstall("pnpm add zod", [{ dir: "/work", ecosystem: "node" }], gate);
        await settled();
        expect(cardOf(gate.events)).toMatchObject({
            kind: "permission",
            toolName: "Bash",
            title: "Install project dependencies",
            program: { text: "pnpm add zod", language: "bash", truncated: false },
            alwaysLabel: "Allow installs for this conversation",
        });
        expect(answer(gate.events, "once")).toBe("settled");
        expect(await pending).toMatchObject({ allow: true });
        expect(gate.events.some((event) => event.kind === "resolved")).toBe(true);
        expect(gate.grants.has(gate.conversationId ?? "")).toBe(false);
    });

    test("allowing for the conversation stops the asking for its later installs", async () => {
        const gate = options(shared, { mode: "ask" });
        const pending = decideProjectInstall("pnpm add zod", [{ dir: "/work", ecosystem: "node" }], gate);
        await settled();
        expect(answer(gate.events, "always")).toBe("settled");
        expect(await pending).toMatchObject({ allow: true });
        const before = gate.events.length;
        expect(await decideProjectInstall("pnpm add vue", [{ dir: "/work", ecosystem: "node" }], gate)).toMatchObject({ allow: true });
        expect(gate.events.length).toBe(before);
    });

    test("a declined card refuses with the owner's own words when they gave some", async () => {
        const gate = options(shared, { mode: "ask" });
        const pending = decideProjectInstall("pnpm add left-pad", [{ dir: "/work", ecosystem: "node" }], gate);
        await settled();
        expect(answer(gate.events, "deny", "Use the standard library.")).toBe("settled");
        expect(await pending).toEqual({ allow: false, reason: "Use the standard library." });
    });

    test("an unattended turn is refused without a card, unless somebody has since steered it", async () => {
        const nobody = options(shared, { mode: "ask", unattended: true });
        expect(await decideProjectInstall("pnpm add zod", [{ dir: "/work", ecosystem: "node" }], nobody)).toMatchObject({
            allow: false,
            reason: expect.stringContaining("running unattended"),
        });
        expect(nobody.events).toEqual([]);
        const steered = options(shared, { mode: "ask", unattended: true, steered: () => true });
        const pending = decideProjectInstall("pnpm add zod", [{ dir: "/work", ecosystem: "node" }], steered);
        await settled();
        expect(answer(steered.events, "once")).toBe("settled");
        expect(await pending).toMatchObject({ allow: true });
    });

    test("automatic in the main tree runs, and says it takes the install lane", async () => {
        expect(await decideProjectInstall("pnpm add zod", [{ dir: "/work", ecosystem: "node" }], options(shared))).toMatchObject({
            allow: true,
            note: expect.stringContaining("install lane"),
            unprepared: [],
        });
    });
});
