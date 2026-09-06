import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitRunner } from "@intentic/scaffold";
import { afterEach, describe, expect, test, vi } from "vitest";
import { lockfileBehind, reconcileLockfile } from "./lockfile-reconcile.js";

// A fake tree: what `git status` and `git diff --name-only` answer, and whether a lockfile exists on disk.
const dirs: string[] = [];
const tree = async (options: { readonly lockfile: boolean; readonly dirty?: string[]; readonly committed?: string[] }) => {
    const dir = await mkdtemp(join(tmpdir(), "lockfile-reconcile-"));
    dirs.push(dir);
    if (options.lockfile) {
        await writeFile(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    }
    const git: GitRunner = async (_dir, args) => {
        if (args[0] === "status") {
            return { stdout: (options.dirty ?? []).map((path) => ` M ${path}`).join("\n"), stderr: "" };
        }
        if (args[0] === "diff") {
            return { stdout: (options.committed ?? []).join("\n"), stderr: "" };
        }
        throw new Error(`unexpected git ${args.join(" ")}`);
    };
    return { dir, git };
};
afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("the lockfile leaves the worktree with the manifest it records", () => {
    test("a dirty package.json with the lockfile untouched is behind", async () => {
        const { dir, git } = await tree({ lockfile: true, dirty: ["_tools/x/package.json"] });
        expect(await lockfileBehind(dir, undefined, git)).toBe(true);
    });

    test("a manifest committed since the last land counts the same as a dirty one", async () => {
        const { dir, git } = await tree({ lockfile: true, committed: ["pnpm-workspace.yaml"] });
        expect(await lockfileBehind(dir, "abc123", git)).toBe(true);
    });

    test("a delta that carries the lockfile too is current: the agent ran the install itself", async () => {
        const { dir, git } = await tree({ lockfile: true, dirty: ["package.json", "pnpm-lock.yaml"] });
        expect(await lockfileBehind(dir, undefined, git)).toBe(false);
    });

    test("a delta with no manifest in it, and a tree with no pnpm lockfile, have nothing to reconcile", async () => {
        const source = await tree({ lockfile: true, dirty: ["src/a.ts"] });
        expect(await lockfileBehind(source.dir, undefined, source.git)).toBe(false);
        const npm = await tree({ lockfile: false, dirty: ["package.json"] });
        expect(await lockfileBehind(npm.dir, undefined, npm.git)).toBe(false);
    });

    test("reconcile runs the resolution in the worktree exactly when it is behind, and a failed one leaves the tree alone", async () => {
        const behind = await tree({ lockfile: true, dirty: ["package.json"] });
        const install = vi.fn(async () => undefined);
        expect(await reconcileLockfile(behind.dir, undefined, behind.git, install)).toBe("regenerated");
        expect(install).toHaveBeenCalledWith(behind.dir);

        const current = await tree({ lockfile: true, dirty: ["src/a.ts"] });
        const untouched = vi.fn(async () => undefined);
        expect(await reconcileLockfile(current.dir, undefined, current.git, untouched)).toBe("current");
        expect(untouched).toHaveBeenCalledTimes(0);

        const failing = vi.fn(async () => {
            throw new Error("ERR_PNPM_NO_MATCHING_VERSION");
        });
        expect(await reconcileLockfile(behind.dir, undefined, behind.git, failing)).toBe("failed");
    });
});
