import { setTimeout as delay } from "node:timers/promises";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
    // A connected browser's profile churns credential files constantly — still never watched (event-spam guard).
    expect(watchIgnored(at(".intentic", "browser", "reddit", "Default", "Cookies"))).toBe(true);
    // Agent worktrees are full checkouts an agent edits at speed — never watched; sibling .claude config is.
    expect(watchIgnored(at("app", ".claude", "worktrees", "fix", "src", "main.ts"))).toBe(true);
    expect(watchIgnored(at("app", ".claude", "settings.json"))).toBe(false);
    // The daemon's own state: the iq index's WAL churns for minutes through a rebuild's re-embed, and the agent
    // transcripts churn through every turn — watching either feeds the daemon (and every browser) its own noise.
    expect(watchIgnored(at(".intentic", "cache", "iq", "index.db-wal"))).toBe(true);
    expect(watchIgnored(at(".intentic", "sessions", "claude", "projects", "-work", "session.jsonl"))).toBe(true);
    expect(watchIgnored(at(".intentic", "auth", "codex", "default", "auth.json"))).toBe(true);
    expect(watchIgnored(at(".intentic", "runtime", "extensions", "whatsapp", "gateway.url"))).toBe(true);
    // The manifests next to them still push: that's how another member's capability write reaches this browser.
    expect(watchIgnored(at(".intentic", "capabilities.json"))).toBe(false);
    expect(watchIgnored(at(".intentic", "environment.Dockerfile"))).toBe(false);
    expect(watchIgnored(at(".intentic", "approvals", "wake-1.json"))).toBe(false);
    // No security floor: secret files are watched now, so a change to .env pushes a refresh like any other file.
    expect(watchIgnored(at("app", ".env"))).toBe(false);
    expect(watchIgnored(at("app", ".env.example"))).toBe(false);
    expect(watchIgnored(at("app", "src", "main.ts"))).toBe(false);
    // The reference shelf: a clone into it writes thousands of files in one burst — never watched. Only the
    // ROOT-level refs/ is the shelf; a repo's own refs dir pushes like any source dir.
    expect(watchIgnored(at("refs", "react", "packages", "scheduler", "index.js"))).toBe(true);
    expect(watchIgnored(at("app", "refs", "notes.md"))).toBe(false);
});

// What only a real filesystem can answer: that the watcher's descent filter is wired to the ignore rules, and
// that what comes out the other side is root-relative. How a burst is BATCHED is not asserted here — that
// depends on whether the machine delivered both filesystem events inside one 250ms window, which is a fact
// about the runner rather than about the watcher. workspace-watch.test.ts settles the batching on its own clock.
test("createWorkspaceWatch emits visible root-relative paths and never announces node_modules", async () => {
    const root = await mkdtemp(join(tmpdir(), "ws-watch-"));
    await mkdir(join(root, "app", "node_modules", "dep"), { recursive: true });
    const watch = createWorkspaceWatch(root);
    const batches: string[][] = [];
    watch.subscribe((paths) => batches.push(paths));
    try {
        // Let the backend finish arming before we mutate — subscribing is async, and a change that lands first
        // is simply never reported.
        await delay(500);

        // A change under node_modules must never be announced (it's a descent-ignored dir).
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

/* THE SKIP GLOBS ACTUALLY PRUNING, which is the half a unit test cannot reach. workspace-watch.test.ts can say
 * a rule carries a glob and a predicate; only a real watcher over a real tree can say the glob was written in a
 * form the backend understands. A glob that silently matches nothing costs no correctness — the predicate still
 * filters the event — so the symptom would be invisible except as handles on a big checkout. Hence this test.
 *
 * The two anchoring mistakes it is here to catch: a root-anchored rule written any-depth (which would silence a
 * repo's own refs/ directory) and an any-depth rule written root-anchored (which would leave nested state dirs
 * churning). Both are asserted through one drop of writes. */
test("the ignore globs prune each hand-written rule, and only where the rule says", async () => {
    const root = await mkdtemp(join(tmpdir(), "ws-watch-globs-"));
    await mkdir(join(root, "refs", "vendored"), { recursive: true });
    await mkdir(join(root, "myrepo", "refs"), { recursive: true });
    await mkdir(join(root, ".intentic", "sessions", "claude"), { recursive: true });
    await mkdir(join(root, ".intentic", "browser", "reddit"), { recursive: true });
    await mkdir(join(root, "app", ".claude", "worktrees", "fix"), { recursive: true });
    await mkdir(join(root, "app", ".claude"), { recursive: true });
    const watch = createWorkspaceWatch(root);
    const batches: string[][] = [];
    watch.subscribe((paths) => batches.push(paths));
    try {
        await delay(500);
        await Promise.all([
            writeFile(join(root, "refs", "vendored", "clone.js"), "x"),
            writeFile(join(root, ".intentic", "sessions", "claude", "session.jsonl"), "x"),
            writeFile(join(root, ".intentic", "browser", "reddit", "Cookies"), "x"),
            writeFile(join(root, "app", ".claude", "worktrees", "fix", "main.ts"), "x"),
            // The three that MUST still push: a repo's own refs/, sibling .claude config, and a manifest that
            // sits directly in the daemon's state dir rather than under one of its churning subtrees.
            writeFile(join(root, "myrepo", "refs", "notes.md"), "x"),
            writeFile(join(root, "app", ".claude", "settings.json"), "x"),
            writeFile(join(root, ".intentic", "capabilities.json"), "x"),
        ]);

        await waitFor(() => batches.flat().length >= 3, 5000);
        const all = batches.flat();

        expect(all).toContain("myrepo/refs/notes.md");
        expect(all).toContain("app/.claude/settings.json");
        expect(all).toContain(".intentic/capabilities.json");
        expect(all.some((path) => path.startsWith("refs/"))).toBe(false);
        expect(all.some((path) => path.includes("sessions"))).toBe(false);
        expect(all.some((path) => path.includes("browser"))).toBe(false);
        expect(all.some((path) => path.includes("worktrees"))).toBe(false);
    } finally {
        await watch.close();
        await rm(root, { recursive: true, force: true });
    }
});
