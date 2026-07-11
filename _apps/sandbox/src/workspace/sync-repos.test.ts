import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { Services } from "../composition.js";
import { syncAdvisory, syncWorkspaceRepos } from "./sync-repos.js";
import { workspacePaths } from "./workspace.js";

// Minimal Services for the sync path: it only touches workspace.{repositories,repos} and git.sync. The fake
// git.sync mirrors real git — `git -C <missing> remote` throws — so a regressed (unfiltered) sync would turn a
// never-scaffolded repo into an "error" outcome, exactly the bug this guards.
const makeServices = (root: string): Services =>
    ({
        workspace: workspacePaths(root),
        git: {
            sync: async (dir: string) => {
                if (!existsSync(dir)) {
                    throw new Error(`Command failed: git -C ${dir} remote\nfatal: cannot change to '${dir}': No such file or directory`);
                }
                return { status: "current" as const };
            },
        },
    }) as unknown as Services;

const withWorkspace = async (run: (root: string) => Promise<void>): Promise<void> => {
    const root = await mkdtemp(join(tmpdir(), "intentic-sync-test-"));
    try {
        await run(root);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
};

test("a neutral sandbox (no role repos on disk) reports no sync failures", async () => {
    await withWorkspace(async (root) => {
        const results = await syncWorkspaceRepos(makeServices(root), 0);
        expect(results.some(({ outcome }) => outcome.status === "error")).toBe(false);
        expect(syncAdvisory(results)).toBeUndefined();
    });
});

test("syncs only the role repos that exist, skipping the never-scaffolded ones", async () => {
    await withWorkspace(async (root) => {
        const paths = workspacePaths(root);
        await mkdir(paths.repos.app, { recursive: true }); // app built; intent + desired-state absent (no DevOps)
        const results = await syncWorkspaceRepos(makeServices(root), 0);
        expect(results.map(({ repo }) => repo)).toEqual(["app"]);
        expect(results.some(({ outcome }) => outcome.status === "error")).toBe(false);
    });
});
