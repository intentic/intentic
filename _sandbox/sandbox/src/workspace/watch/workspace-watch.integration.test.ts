import { setTimeout as delay } from "node:timers/promises";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { expect, test } from "vitest";
import { createWorkspaceWatch, isWatchIgnored } from "./workspace-watch.js";

const ROOT = join(sep, "work");
const at = (...segments: string[]): string => join(ROOT, ...segments);
const watchIgnored = (abs: string): boolean => isWatchIgnored(ROOT, abs);
const waitFor = async (predicate: () => boolean, timeoutMs: number): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate() && Date.now() < deadline) {
        await delay(25);
    }
};

test("isWatchIgnored skips junk dirs (incl. .git) + browser profiles, but not source or former-secret files", () => {
    expect(watchIgnored(at("app", "node_modules", "dep", "index.js"))).toBe(true);
    expect(watchIgnored(at("app", ".git", "config"))).toBe(true);
    expect(watchIgnored(at("app", "dist", "bundle.js"))).toBe(true);
    // A browser profile's credential files churn constantly; never watched.
    expect(watchIgnored(at(".intentic", "local", "browser", "reddit", "Default", "Cookies"))).toBe(true);
    // Agent worktrees are full checkouts an agent edits at speed: never watched; sibling .claude config is.
    expect(watchIgnored(at("app", ".claude", "worktrees", "fix", "src", "main.ts"))).toBe(true);
    expect(watchIgnored(at("app", ".claude", "settings.json"))).toBe(false);
    // Daemon state that churns constantly (iq WAL, transcripts) is never watched, to avoid feeding back noise.
    expect(watchIgnored(at(".intentic", "local", "cache", "iq", "index.db-wal"))).toBe(true);
    expect(watchIgnored(at(".intentic", "records", "sessions", "claude", "projects", "-work", "session.jsonl"))).toBe(true);
    expect(watchIgnored(at(".intentic", "secrets", "auth", "codex", "default", "auth.json"))).toBe(true);
    expect(watchIgnored(at(".intentic", "local", "runtime", "extensions", "whatsapp", "gateway.url"))).toBe(true);
    // The manifests next to them still push: that's how another member's capability write reaches this browser.
    expect(watchIgnored(at(".intentic", "config", "capabilities.json"))).toBe(false);
    expect(watchIgnored(at(".intentic", "config", "environment.Dockerfile"))).toBe(false);
    expect(watchIgnored(at(".intentic", "records", "approvals", "wake-1.json"))).toBe(false);
    // No security floor: a secret file like .env pushes a refresh like any other file.
    expect(watchIgnored(at("app", ".env"))).toBe(false);
    expect(watchIgnored(at("app", ".env.example"))).toBe(false);
    expect(watchIgnored(at("app", "src", "main.ts"))).toBe(false);
    // Only the root-level refs/ shelf is ignored; a repo's own nested refs/ pushes normally.
    expect(watchIgnored(at("refs", "react", "packages", "scheduler", "index.js"))).toBe(true);
    expect(watchIgnored(at("app", "refs", "notes.md"))).toBe(false);
});

// Proves the filter is wired for real paths, root-relative; batching timing lives in workspace-watch.test.ts.
test("createWorkspaceWatch emits visible root-relative paths and never announces node_modules", async () => {
    const root = await mkdtemp(join(tmpdir(), "ws-watch-"));
    await mkdir(join(root, "app", "node_modules", "dep"), { recursive: true });
    const watch = createWorkspaceWatch(root);
    const batches: string[][] = [];
    watch.subscribe((paths) => batches.push(paths));
    try {
        // Backend needs to finish arming (subscribe is async) before a write can be seen.
        await delay(500);

        await writeFile(join(root, "app", "node_modules", "dep", "index.js"), "x");
        await Promise.all([writeFile(join(root, "a.txt"), "1"), writeFile(join(root, "b.txt"), "2")]);

        await waitFor(() => batches.flat().length >= 2, 5000);

        const all = batches.flat();
        expect(all).toContain("a.txt");
        expect(all).toContain("b.txt");
        expect(all.some((path) => path.includes("node_modules"))).toBe(false);
    } finally {
        await watch.close();
        await rm(root, { recursive: true, force: true });
    }
});

// Mimics Fly's setup: /work is a symlink onto the mounted volume, and the native watcher refuses a symlink as its
// inotify root unless resolved first.
test("createWorkspaceWatch follows a hosted-style symlink root", async () => {
    const temp = await mkdtemp(join(tmpdir(), "ws-watch-link-"));
    const volumeRoot = join(temp, "data", "work");
    const root = join(temp, "work");
    await mkdir(volumeRoot, { recursive: true });
    await symlink(volumeRoot, root, "dir");
    const watch = createWorkspaceWatch(root);
    const batches: string[][] = [];
    watch.subscribe((paths) => batches.push(paths));
    try {
        await delay(500);
        await writeFile(join(root, "hosted.txt"), "ready");
        await waitFor(() => batches.flat().includes("hosted.txt"), 5000);
        expect(batches.flat()).toContain("hosted.txt");
    } finally {
        await watch.close();
        await rm(temp, { recursive: true, force: true });
    }
});

// Proves the glob strings actually match in a real watcher, not just that a rule carries one; catches a root-anchored
// rule written any-depth (silencing a repo's own refs/) or vice versa (leaving nested state dirs churning).
test("the ignore globs prune each hand-written rule, and only where the rule says", async () => {
    const root = await mkdtemp(join(tmpdir(), "ws-watch-globs-"));
    await mkdir(join(root, "refs", "vendored"), { recursive: true });
    await mkdir(join(root, "myrepo", "refs"), { recursive: true });
    await mkdir(join(root, ".intentic", "records", "sessions", "claude"), { recursive: true });
    await mkdir(join(root, ".intentic", "local", "browser", "reddit"), { recursive: true });
    // Manifests now live one level deeper, in their own group folder, not directly in the state dir.
    await mkdir(join(root, ".intentic", "config"), { recursive: true });
    await mkdir(join(root, "app", ".claude", "worktrees", "fix"), { recursive: true });
    await mkdir(join(root, "app", ".claude"), { recursive: true });
    const watch = createWorkspaceWatch(root);
    const batches: string[][] = [];
    watch.subscribe((paths) => batches.push(paths));
    try {
        await delay(500);
        await Promise.all([
            writeFile(join(root, "refs", "vendored", "clone.js"), "x"),
            writeFile(join(root, ".intentic", "records", "sessions", "claude", "session.jsonl"), "x"),
            writeFile(join(root, ".intentic", "local", "browser", "reddit", "Cookies"), "x"),
            writeFile(join(root, "app", ".claude", "worktrees", "fix", "main.ts"), "x"),
            // The three writes that must still push: a repo's refs/, sibling .claude config, a manifest outside the
            // churn.
            writeFile(join(root, "myrepo", "refs", "notes.md"), "x"),
            writeFile(join(root, "app", ".claude", "settings.json"), "x"),
            writeFile(join(root, ".intentic", "config", "capabilities.json"), "x"),
        ]);

        await waitFor(() => batches.flat().length >= 3, 5000);
        const all = batches.flat();

        expect(all).toContain("myrepo/refs/notes.md");
        expect(all).toContain("app/.claude/settings.json");
        expect(all).toContain(".intentic/config/capabilities.json");
        expect(all.some((path) => path.startsWith("refs/"))).toBe(false);
        expect(all.some((path) => path.includes("sessions"))).toBe(false);
        expect(all.some((path) => path.includes("browser"))).toBe(false);
        expect(all.some((path) => path.includes("worktrees"))).toBe(false);
    } finally {
        await watch.close();
        await rm(root, { recursive: true, force: true });
    }
});
