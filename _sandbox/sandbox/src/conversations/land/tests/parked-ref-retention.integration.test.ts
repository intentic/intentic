import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { recordingLogger } from "../../../harness/route-fakes.testing.js";
import { DAY_MS } from "../../../system/chore-clock.js";
import { workspacePaths } from "../../../workspace/workspace.js";
import { carriedRef, parkedRefOf } from "../agent-refs.js";
import {
    deleteRefsAtomically,
    PARKED_REF_RETENTION_MS,
    type ParkedRefRetentionDeps,
    parkedRefRetentionChore,
    runParkedRefRetention,
} from "../parked-ref-retention.js";

// The daily retention against a real repository: which refs go, which stay, and that a ref that moved since it was read
// is never deleted.

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();

const NOW = Date.parse("2026-10-05T12:00:00Z");
const LONG_AGO = NOW - PARKED_REF_RETENTION_MS - DAY_MS;

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

// A workspace whose root repo holds parked branches for these conversation ids, one commit each.
const workspaceWith = async (ids: readonly string[]): Promise<{ work: string; tips: Map<string, string> }> => {
    const work = await mkdtemp(join(tmpdir(), "intentic-parked-refs-"));
    tempDirs.push(work);
    await sh(work, "init", "-q", "-b", "main");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base");
    const tips = new Map<string, string>();
    for (const id of ids) {
        const sha = await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", id);
        await sh(work, "update-ref", parkedRefOf(id), sha);
        tips.set(id, sha);
    }
    return { work, tips };
};

const refsIn = async (work: string): Promise<string[]> =>
    (await sh(work, "for-each-ref", "--format=%(refname)", "refs/agent/", "refs/intentic/", "refs/heads/agent/"))
        .split("\n")
        .filter((ref) => ref !== "");

const deps = (work: string, entries: Record<string, { archivedAt?: number }>, over: Partial<ParkedRefRetentionDeps> = {}) => {
    const { lines, logger } = recordingLogger();
    const retention: ParkedRefRetentionDeps = {
        workspace: workspacePaths(work),
        agents: { entry: (id) => entries[id] },
        agentWorktrees: { mainDir: (repo) => (repo === "root" ? work : join(work, repo)), withRepoLock: (_repo, task) => task() },
        conversations: { liveSessionIds: () => [] },
        logger,
        now: () => NOW,
        ...over,
    };
    return { retention, lines };
};

test("deletes the parked refs and carry markers of conversations archived past the retention, and nothing else", async () => {
    const { work, tips } = await workspaceWith(["old", "recent", "live", "stranger"]);
    // A carry marker of the old conversation, and a live branch of it that was never parked: only the shelf is in scope.
    await sh(work, "update-ref", carriedRef("agent/old"), tips.get("old") ?? "");
    await sh(work, "update-ref", "refs/heads/agent/old", tips.get("old") ?? "");
    const { retention, lines } = deps(work, { old: { archivedAt: LONG_AGO }, recent: { archivedAt: NOW - DAY_MS }, live: {} });

    await runParkedRefRetention(retention);

    expect(await refsIn(work)).toEqual(["refs/agent/live", "refs/agent/recent", "refs/agent/stranger", "refs/heads/agent/old"]);
    expect(lines.find((line) => line["repo"] === "root")).toMatchObject({ parked: 4, dropped: 1, kept: 2, unknown: 1, failed: 0, retentionDays: 90 });
});

test("a ref that moved after it was read is not deleted, and neither is the rest of its batch", async () => {
    const { work, tips } = await workspaceWith(["a", "b"]);
    const tipOfA = tips.get("a") ?? "";
    await expect(
        deleteRefsAtomically(work, [
            { ref: parkedRefOf("a"), sha: tips.get("b") ?? "" },
            { ref: parkedRefOf("b"), sha: tips.get("b") ?? "" },
        ]),
    ).rejects.toThrow();
    expect(await sh(work, "rev-parse", parkedRefOf("a"))).toBe(tipOfA);
    expect(await refsIn(work)).toEqual(["refs/agent/a", "refs/agent/b"]);
});

test("a batch that fails is logged and left for tomorrow", async () => {
    const { work } = await workspaceWith(["old"]);
    const { retention, lines } = deps(
        work,
        { old: { archivedAt: LONG_AGO } },
        { deleteRefs: async () => Promise.reject(new Error("packed-refs.lock: File exists")) },
    );
    await runParkedRefRetention(retention);
    expect(await refsIn(work)).toEqual(["refs/agent/old"]);
    expect(lines.find((line) => line["level"] === "warn")).toMatchObject({ repo: "root", refs: 1 });
    expect(lines.find((line) => line["repo"] === "root" && line["level"] === "info")).toMatchObject({ dropped: 0, failed: 1 });
});

test("a turn that is live holds the deletions", async () => {
    const { work } = await workspaceWith(["old"]);
    const { retention } = deps(work, { old: { archivedAt: LONG_AGO } }, { conversations: { liveSessionIds: () => ["session-1"] } });
    await runParkedRefRetention(retention);
    expect(await refsIn(work)).toEqual(["refs/agent/old"]);
    const chore = parkedRefRetentionChore(retention);
    expect(chore).toMatchObject({ name: "parked-ref-retention", everyMs: DAY_MS });
    expect(chore.when?.()).toBe(false);
});
