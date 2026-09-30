import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { parkedCards } from "../../conversations/actor/parked-cards.js";
import type { IsolationPlan } from "../../conversations/worktrees/isolation.js";
import { opt } from "../../opt.js";
import { memoryConversationGrants } from "../../personas/conversation-grants.js";
import { memoryFleet } from "../../testing.js";
import type { ProjectInstall } from "./agent-installs.js";
import {
    consultProjectInstall,
    detachMirrors,
    type InstallAsking,
    installGrantsOf,
    installRootOf,
    type InstallPlacement,
    PROJECT_INSTALL_RULE,
    type ProjectInstallGate,
    type ProjectInstallVerdict,
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

// The conversation's kept grants, in memory: the same store the daemon keeps under the auth root.
const grantsStore = memoryConversationGrants();

const gateOf = (placement: InstallPlacement, over: Partial<ProjectInstallGate> = {}): ProjectInstallGate => ({
    placement,
    root: "/work",
    mode: "automatic",
    canInstall: true,
    grants: installGrantsOf(grantsStore, `c-${Math.random().toString(36).slice(2)}`),
    rule: PROJECT_INSTALL_RULE,
    ...over,
});

const ASKING: InstallAsking = { cards, signal: new AbortController().signal, canPark: true };

// Drives one consult the way the command gate does: every frame it says, in order, and its verdict once it has one.
const run = (
    command: string,
    installs: readonly ProjectInstall[],
    gate: ProjectInstallGate,
    asking: InstallAsking = ASKING,
): { readonly events: AgentEvent[]; readonly verdict: Promise<ProjectInstallVerdict> } => {
    const events: AgentEvent[] = [];
    const verdict = (async () => {
        const consulting = consultProjectInstall(command, installs, gate, asking);
        let step = await consulting.next();
        while (step.done !== true) {
            events.push(step.value);
            step = await consulting.next();
        }
        return step.value;
    })();
    return { events, verdict };
};

const verdictOf = (command: string, installs: readonly ProjectInstall[], gate: ProjectInstallGate): Promise<ProjectInstallVerdict> =>
    run(command, installs, gate).verdict;

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
    const consulted = run("npm install remotion", [{ dir: "/work/video", ecosystem: "node" }], gateOf({ kind: "private", plan: planOf(tree) }));
    expect(await consulted.verdict).toMatchObject({ allow: true, unprepared: [] });
    // The chat is told as it starts: where it writes, and which project it works on.
    expect(consulted.events).toEqual([{ kind: "install", reach: "own-copy", projects: ["video"] }]);
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
    await verdictOf("mkdir -p app && cd app && npm init -y && npm install zod", [{ dir: "/work/app", ecosystem: "node" }], gateOf({ kind: "private", plan: planOf(tree) }));
    expect(await ignored(tree, "app/node_modules/")).toBe(true);
});

test("a project whose own .gitignore already covers it gets no exclude line", async () => {
    const tree = await worktree();
    await mkdir(join(tree, "web"), { recursive: true });
    await writeFile(join(tree, "web", ".gitignore"), "node_modules/\n");
    await writeFile(join(tree, "web", "package.json"), "{}");
    await verdictOf("pnpm add zod", [{ dir: "/work/web", ecosystem: "node" }], gateOf({ kind: "private", plan: planOf(tree) }));
    const exclude = await readFile(join(tree, ".git", "info", "exclude"), "utf8");
    expect(exclude).not.toContain("/web/");
});

test("a python project's virtualenv is kept out of the land at the project, not below it", async () => {
    const tree = await worktree();
    await mkdir(join(tree, "svc"), { recursive: true });
    await writeFile(join(tree, "svc", "pyproject.toml"), "[project]\nname = 'svc'\n");
    await verdictOf("uv sync", [{ dir: "/work/svc", ecosystem: "python" }], gateOf({ kind: "private", plan: planOf(tree) }));
    expect(await readFile(join(tree, ".git", "info", "exclude"), "utf8")).toContain("/svc/.venv/");
});

test("an install outside the conversation's tree prepares nothing and still runs", async () => {
    const tree = await worktree();
    const consulted = run("npm install", [{ dir: "/tmp/scratch", ecosystem: "node" }], gateOf({ kind: "private", plan: planOf(tree) }));
    expect(await consulted.verdict).toMatchObject({ allow: true, unprepared: [] });
    // Nothing of the tree to name; the chat still hears where it writes.
    expect(consulted.events).toEqual([{ kind: "install", reach: "own-copy", projects: [] }]);
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
    const ROOT_INSTALL: readonly ProjectInstall[] = [{ dir: "/work", ecosystem: "node" }];

    test("never refuses, and says the manifest change still installs at the land", async () => {
        const consulted = run("pnpm add zod", ROOT_INSTALL, gateOf(shared, { mode: "never" }));
        expect(await consulted.verdict).toMatchObject({ allow: false, reason: expect.stringContaining("installs when the owner lands the work") });
        expect(consulted.events).toEqual([]);
    });

    test("a persona without the power to change the workspace is refused whatever the setting", async () => {
        expect(await verdictOf("pnpm add zod", ROOT_INSTALL, gateOf(shared, { canInstall: false }))).toMatchObject({
            allow: false,
            reason: expect.stringContaining("ask the owner"),
        });
    });

    test("ask parks one card; allowing it once runs this install and asks again next time", async () => {
        const gate = gateOf(shared, { mode: "ask" });
        const first = run("pnpm add zod", ROOT_INSTALL, gate);
        await settled();
        expect(cardOf(first.events)).toMatchObject({
            kind: "permission",
            toolName: "Bash",
            title: "Install project dependencies",
            program: { text: "pnpm add zod", language: "bash", truncated: false },
            alwaysLabel: "Allow installs for this conversation",
        });
        expect(answer(first.events, "once")).toBe("settled");
        expect(await first.verdict).toMatchObject({ allow: true });
        expect(first.events.map((event) => event.kind)).toEqual(["permission", "resolved", "install"]);
        expect(await gate.grants?.has()).toBe(false);
        const second = run("pnpm add vue", ROOT_INSTALL, gate);
        await settled();
        expect(cardOf(second.events)).toMatchObject({ kind: "permission" });
        answer(second.events, "once");
        await second.verdict;
    });

    test("allowing for the conversation is kept, and stops the asking for its later installs", async () => {
        const gate = gateOf(shared, { mode: "ask" });
        const first = run("pnpm add zod", ROOT_INSTALL, gate);
        await settled();
        expect(answer(first.events, "always")).toBe("settled");
        expect(await first.verdict).toMatchObject({ allow: true });
        expect(await gate.grants?.has()).toBe(true);
        const later = run("pnpm add vue", ROOT_INSTALL, gate);
        expect(await later.verdict).toMatchObject({ allow: true });
        expect(later.events).toEqual([{ kind: "install", reach: "main-tree", projects: [""] }]);
    });

    test("a declined card refuses with the owner's own words when they gave some", async () => {
        const consulted = run("pnpm add left-pad", ROOT_INSTALL, gateOf(shared, { mode: "ask" }));
        await settled();
        expect(answer(consulted.events, "deny", "Use the standard library.")).toBe("settled");
        expect(await consulted.verdict).toEqual({ allow: false, reason: "Use the standard library." });
    });

    // Nobody answering yet is not a refusal: the install waits on its card for as long as the answer takes.
    test("an unanswered card keeps the install waiting rather than refusing it", async () => {
        const consulted = run("pnpm add zod", ROOT_INSTALL, gateOf(shared, { mode: "ask" }));
        let done = false;
        void consulted.verdict.then(() => {
            done = true;
        });
        for (let tick = 0; tick < 20; tick += 1) {
            await settled();
        }
        expect(done).toBe(false);
        answer(consulted.events, "once");
        expect(await consulted.verdict).toMatchObject({ allow: true });
    });

    test("a runtime that cannot pause is refused rather than asked", async () => {
        const consulted = run("pnpm add zod", ROOT_INSTALL, gateOf(shared, { mode: "ask" }), { ...ASKING, canPark: false });
        expect(await consulted.verdict).toMatchObject({ allow: false, reason: expect.stringContaining("cannot pause to ask") });
        expect(consulted.events).toEqual([]);
    });

    test("a turn with no conversation is asked without the offer to allow for the conversation", async () => {
        const consulted = run("pnpm add zod", ROOT_INSTALL, gateOf(shared, { mode: "ask", grants: undefined }));
        await settled();
        expect(cardOf(consulted.events)?.alwaysLabel).toBeUndefined();
        answer(consulted.events, "once");
        await consulted.verdict;
    });

    test("automatic in the main tree runs, and says it takes the install lane", async () => {
        expect(await verdictOf("pnpm add zod", ROOT_INSTALL, gateOf(shared))).toMatchObject({
            allow: true,
            note: expect.stringContaining("install lane"),
            unprepared: [],
        });
    });
});
