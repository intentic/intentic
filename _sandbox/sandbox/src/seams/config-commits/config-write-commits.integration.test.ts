import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { SANDBOX_ROUTES } from "@intentic/sandbox-contract";
import { RAW_ROUTE_LIST } from "@intentic/sandbox-contract/protocol/raw/raw-routes";
import { unstubbed } from "@intentic/testing";
import { Hono } from "hono";
import type { AppEnv } from "../../app-env.js";
import type { Services } from "../../composition.js";
import { commitOnly } from "../../git/changes/changes-index.js";
import { CONFIG_WRITES, commitConfigWrites } from "./config-write-commits.js";

// A real repository and a tiny app with the middleware in front of a route the table names: what matters is what git
// holds afterwards, a commit of exactly the files the request wrote, with the owner's own work around it left as it was.

const roots: string[] = [];
afterAll(() => {
    for (const root of roots) {
        rmSync(root, { recursive: true, force: true });
    }
});

const git = (root: string, ...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" });

const ENGINES = `${STATE_DIR}/config/engines.json`;
const AUTOMATIONS = `${STATE_DIR}/config/automations.json`;

const workspace = (): string => {
    const root = mkdtempSync(join(tmpdir(), "config-write-commits-"));
    roots.push(root);
    git(root, "init", "-q");
    mkdirSync(join(root, STATE_DIR, "config"), { recursive: true });
    writeFileSync(join(root, ENGINES), "{}\n");
    writeFileSync(join(root, AUTOMATIONS), "[]\n");
    writeFileSync(join(root, "notes.md"), "mine\n");
    git(root, "add", "-A");
    git(root, "-c", "user.name=owner", "-c", "user.email=owner@example.com", "commit", "-q", "-m", "Initialize workspace");
    return root;
};

const appOn = (root: string, answer: { status: 200 | 500 } = { status: 200 }) => {
    const host = unstubbed<Pick<Services, "agentWorktrees" | "git" | "logger">>("services", {
        agentWorktrees: unstubbed<Services["agentWorktrees"]>("agentWorktrees", {
            mainDir: () => root,
            withRepoLock: async (_repo, run) => run(),
        }),
        git: unstubbed<Services["git"]>("git", { commitOnly }),
        logger: unstubbed<Services["logger"]>("logger", { debug: () => undefined }),
    });
    const app = new Hono<AppEnv>();
    app.use("*", commitConfigWrites(host));
    // Listed: the engine channel page's write, and a draft in a folder git has never seen.
    app.post("/engines/channel", (c) => {
        writeFileSync(join(root, ENGINES), `{"claude":"latest"}\n`);
        return c.json({ ok: true }, answer.status);
    });
    app.post("/environment/reject", (c) => {
        mkdirSync(join(root, STATE_DIR, "config", "environment.d"), { recursive: true });
        writeFileSync(join(root, STATE_DIR, "config", "environment.d", "tool.Dockerfile"), "RUN true\n");
        return c.json({ ok: true });
    });
    // Not a route the table names: a hand edit through the file API stays the owner's.
    app.post("/workspace/file", (c) => {
        writeFileSync(join(root, AUTOMATIONS), `[{"id":"mine"}]\n`);
        return c.json({ ok: true });
    });
    return app;
};

const status = (root: string): string => git(root, "status", "--porcelain", "--untracked-files=all").trim();

// A name that matches no route would commit nothing, silently: a renamed route must be renamed here too.
test("every listed route name is a route this build serves", () => {
    const names = new Set([...SANDBOX_ROUTES, ...RAW_ROUTE_LIST].map((route) => route.name));
    expect([...CONFIG_WRITES.keys()].filter((name) => !names.has(name))).toEqual([]);
});

test("a listed request's write is committed on its own, and the owner's edits stay theirs", async () => {
    const root = workspace();
    writeFileSync(join(root, "notes.md"), "mine, edited\n");

    await appOn(root).request("/engines/channel", { method: "POST" });
    await appOn(root).request("/environment/reject", { method: "POST" });

    expect(git(root, "log", "-2", "--format=%s|%an", "--name-only").trim().split("\n").filter((line) => line !== "")).toEqual([
        "Settings: environment rejected|intentic",
        `${STATE_DIR}/config/environment.d/tool.Dockerfile`,
        "Settings: engine channel|intentic",
        ENGINES,
    ]);
    expect(status(root)).toBe("M notes.md");
});

test("a file that already held uncommitted edits is left uncommitted with the write in it", async () => {
    const root = workspace();
    writeFileSync(join(root, ENGINES), `{"claude":"pinned by hand"}\n`);
    const head = git(root, "rev-parse", "HEAD");

    await appOn(root).request("/engines/channel", { method: "POST" });

    expect(git(root, "rev-parse", "HEAD")).toBe(head);
    expect(status(root)).toBe(`M ${ENGINES}`);
});

test("a failed request and an unlisted one commit nothing", async () => {
    const root = workspace();
    const head = git(root, "rev-parse", "HEAD");

    await appOn(root, { status: 500 }).request("/engines/channel", { method: "POST" });
    await appOn(root).request("/workspace/file", { method: "POST" });

    expect(git(root, "rev-parse", "HEAD")).toBe(head);
    expect(status(root).split("\n").map((line) => line.trim()).sort()).toEqual([`M ${AUTOMATIONS}`, `M ${ENGINES}`]);
});
