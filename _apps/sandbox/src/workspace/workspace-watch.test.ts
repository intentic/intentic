import { setTimeout as delay } from "node:timers/promises";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { expect, test } from "vitest";
import { createWorkspaceWatch, isWatchIgnored } from "./workspace-watch.js";

const at = (...segments: string[]): string => join(sep, "work", ...segments);
const waitFor = async (predicate: () => boolean, timeoutMs: number): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate() && Date.now() < deadline) {
        await delay(25);
    }
};

test("isWatchIgnored skips junk dirs (incl. .git) + browser profiles, but not source or former-secret files", () => {
    expect(isWatchIgnored(at("app", "node_modules", "dep", "index.js"))).toBe(true);
    expect(isWatchIgnored(at("app", ".git", "config"))).toBe(true);
    expect(isWatchIgnored(at("app", "dist", "bundle.js"))).toBe(true);
    // The browser-login profile churns credential files constantly — still never watched (event-spam guard).
    expect(isWatchIgnored(at(".intentic", "browser", "reddit", "Default", "Cookies"))).toBe(true);
    // Agent worktrees are full checkouts an agent edits at speed — never watched; sibling .claude config is.
    expect(isWatchIgnored(at("app", ".claude", "worktrees", "fix", "src", "main.ts"))).toBe(true);
    expect(isWatchIgnored(at("app", ".claude", "settings.json"))).toBe(false);
    // The daemon's own state: the iq index's WAL churns for minutes through a rebuild's re-embed, and the agent
    // transcripts churn through every turn — watching either feeds the daemon (and every browser) its own noise.
    expect(isWatchIgnored(at(".intentic", "iq", "index.db-wal"))).toBe(true);
    expect(isWatchIgnored(at(".intentic", "claude", "projects", "-work", "session.jsonl"))).toBe(true);
    // The manifests next to them still push: that's how another member's capability write reaches this browser.
    expect(isWatchIgnored(at(".intentic", "capabilities.json"))).toBe(false);
    expect(isWatchIgnored(at(".intentic", "environment.Dockerfile"))).toBe(false);
    expect(isWatchIgnored(at(".intentic", "approvals", "wake-1.json"))).toBe(false);
    // No security floor: secret files are watched now, so a change to .env pushes a refresh like any other file.
    expect(isWatchIgnored(at("app", ".env"))).toBe(false);
    expect(isWatchIgnored(at("app", ".env.example"))).toBe(false);
    expect(isWatchIgnored(at("app", "src", "main.ts"))).toBe(false);
});

test("createWorkspaceWatch emits visible root-relative paths, skips node_modules, and coalesces a burst", async () => {
    const root = await mkdtemp(join(tmpdir(), "ws-watch-"));
    await mkdir(join(root, "app", "node_modules", "dep"), { recursive: true });
    const watch = createWorkspaceWatch(root);
    const batches: string[][] = [];
    watch.subscribe((paths) => batches.push(paths));
    try {
        // Let chokidar finish its initial scan so the watchers are armed before we mutate.
        await delay(500);

        // A change under node_modules must never be announced (it's a descent-ignored dir).
        await writeFile(join(root, "app", "node_modules", "dep", "index.js"), "x");
        // Two visible writes in the same debounce window should coalesce into ONE batch.
        await Promise.all([writeFile(join(root, "a.txt"), "1"), writeFile(join(root, "b.txt"), "2")]);

        await waitFor(() => batches.length > 0, 3000);
        await delay(400); // let any trailing batch land before asserting coalescing

        const all = batches.flat();
        expect(all).toContain("a.txt");
        expect(all).toContain("b.txt");
        expect(all.some((path) => path.includes("node_modules"))).toBe(false);
        expect(batches.length).toBe(1);
    } finally {
        await watch.close();
        await rm(root, { recursive: true, force: true });
    }
});
