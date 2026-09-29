import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { call } from "@orpc/server";
import type { OrpcContext } from "../app-env.js";
import type { Services } from "../composition.js";
import { fileSafetyPolicyStore } from "../safety/safety-policy-store.js";
import { createSafetyRoutes } from "../safety/safety.routes.js";
import { createSettingsRoutes } from "./settings.routes.js";
import { fileSandboxSettingsStore, settingsDocument } from "./settings-store.js";
import { versionedSettingsWrite, versionSettingsWrite } from "./settings-versions.js";

// A real repository: what matters is what git holds afterwards, a commit of exactly the settings page's write, with the
// owner's own work around it left dirty and staged just as it was.

const roots: string[] = [];
afterAll(() => {
    for (const root of roots) {
        rmSync(root, { recursive: true, force: true });
    }
});

const git = (root: string, ...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" });

const PERSONAS = ".intentic/config/personas.json";

const workspace = (): string => {
    const root = mkdtempSync(join(tmpdir(), "settings-versions-"));
    roots.push(root);
    git(root, "init", "-q");
    mkdirSync(join(root, ".intentic", "config"), { recursive: true });
    writeFileSync(join(root, PERSONAS), "[]\n");
    writeFileSync(join(root, "notes.md"), "mine\n");
    git(root, "add", "-A");
    git(root, "-c", "user.name=owner", "-c", "user.email=owner@example.com", "commit", "-q", "-m", "Initialize workspace");
    return root;
};

const hostOn = (root: string, locked: string[] = []) =>
    unstubbed<Pick<Services, "agentWorktrees" | "logger">>("services", {
        agentWorktrees: unstubbed<Services["agentWorktrees"]>("agentWorktrees", {
            mainDir: () => root,
            withRepoLock: async (repo, run) => {
                locked.push(repo);
                return run();
            },
        }),
        logger: unstubbed<Services["logger"]>("logger", { debug: () => undefined }),
    });

const status = (root: string): string => git(root, "status", "--porcelain").trim();

test("a settings write is committed on its own, and the owner's edits stay theirs, dirty and staged as they were", async () => {
    const root = workspace();
    writeFileSync(join(root, PERSONAS), `[{"id":"studio","label":"Studio","capabilities":[]}]\n`);
    writeFileSync(join(root, "notes.md"), "mine, edited\n");
    writeFileSync(join(root, "draft.md"), "staged\n");
    git(root, "add", "draft.md");
    const locked: string[] = [];

    expect(await versionSettingsWrite(hostOn(root, locked), [PERSONAS], "Settings: persona Studio")).toBe(true);

    expect(git(root, "log", "-1", "--format=%s|%an", "--name-only").trim().split("\n")).toEqual(["Settings: persona Studio|intentic", "", PERSONAS]);
    expect(status(root)).toBe("A  draft.md\n M notes.md");
    // Under the root repo's lock, so a land touching the same file queues behind it rather than racing it.
    expect(locked).toEqual(["root"]);
});

test("a removed persona's kit is committed as gone, and a kit that never existed is left out rather than failing it", async () => {
    const root = workspace();
    const kit = ".intentic/config/personas/studio";
    mkdirSync(join(root, kit), { recursive: true });
    writeFileSync(join(root, kit, "PROMPT.md"), "You write release notes.\n");
    await versionSettingsWrite(hostOn(root), [kit], "Settings: persona Studio prompt");
    rmSync(join(root, kit), { recursive: true });
    writeFileSync(join(root, PERSONAS), "[]\n\n");

    expect(await versionSettingsWrite(hostOn(root), [PERSONAS, kit, ".intentic/config/personas/ghost"], "Settings: removed persona Studio")).toBe(true);

    expect(status(root)).toBe("");
    expect(git(root, "ls-files", kit).trim()).toBe("");
});

test("nothing changed is nothing committed", async () => {
    const root = workspace();
    const head = git(root, "rev-parse", "HEAD");

    expect(await versionSettingsWrite(hostOn(root), [PERSONAS], "Settings: persona Studio")).toBe(false);
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
});

// A workspace that brought its own `.git` excludes `.intentic` altogether: the write stays a plain file, and the page's
// save still succeeds.
test("a workspace that ignores its settings folder keeps the write uncommitted, without failing it", async () => {
    const root = workspace();
    writeFileSync(join(root, ".git", "info", "exclude"), "/.intentic/\n");
    git(root, "rm", "-r", "-q", "--cached", ".intentic");
    git(root, "-c", "user.name=owner", "-c", "user.email=owner@example.com", "commit", "-q", "-m", "untrack settings");
    writeFileSync(join(root, PERSONAS), `[{"id":"studio","capabilities":[]}]\n`);
    const head = git(root, "rev-parse", "HEAD");

    expect(await versionSettingsWrite(hostOn(root), [PERSONAS], "Settings: persona studio")).toBe(false);
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
});

// G4's leftover: the Agent tab's saves to settings.json were never committed, so a land touching the file was refused as
// the owner's edits just as a persona save's once was.
test("an Agent tab save is committed on its own, as a settings page's write", async () => {
    const root = workspace();
    const host = hostOn(root);
    const services = unstubbed<Services>("services", {
        agentWorktrees: host.agentWorktrees,
        sandboxSettings: fileSandboxSettingsStore(join(root, settingsDocument.path)),
        // The baked skills it converges afterwards only warn when they cannot be written.
        logger: unstubbed<Services["logger"]>("logger", { debug: () => undefined, warn: () => undefined }),
    });
    const context: OrpcContext = { headers: new Headers(), method: "POST", url: "/settings/set" };

    await call(createSettingsRoutes(services).set, SandboxSettingsSchema.parse({ autoRepair: false }), { context });

    expect(git(root, "log", "-1", "--format=%s|%an", "--name-only").trim().split("\n")).toEqual([
        "Settings: agent settings|intentic",
        "",
        settingsDocument.path,
    ]);
    expect(status(root)).toBe("");
});

// settings.json is also the manifest an owner edits by hand: edits already sitting in it are theirs to commit, and a
// page's save on top of them is left beside them rather than sweeping them in under the page's subject.
test("a settings file already holding uncommitted edits is written but left uncommitted", async () => {
    const root = workspace();
    const head = git(root, "rev-parse", "HEAD");
    writeFileSync(join(root, PERSONAS), `[{"id":"mine","capabilities":[]}]\n`);

    const written = await versionedSettingsWrite(hostOn(root), [PERSONAS], "Settings: persona Studio", async () => {
        writeFileSync(join(root, PERSONAS), `[{"id":"mine","capabilities":[]},{"id":"studio","capabilities":[]}]\n`);
        return "saved";
    });

    expect(written).toBe("saved");
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
    expect(status(root)).toBe(`M ${PERSONAS}`);
});

test("a Safety page save is committed on its own too", async () => {
    const root = workspace();
    const host = hostOn(root);
    const routes = createSafetyRoutes(
        unstubbed<Parameters<typeof createSafetyRoutes>[0]>("services", {
            ...host,
            safetyPolicy: fileSafetyPolicyStore(join(root, ".intentic/config/safety.md")),
        }),
    );

    await call(routes.setPolicy, { text: "Never push to main.\n" }, { context: { headers: new Headers(), method: "POST", url: "/safety/policy" } });

    expect(git(root, "log", "-1", "--format=%s", "--name-only").trim().split("\n")).toEqual(["Settings: safety policy", "", ".intentic/config/safety.md"]);
});
