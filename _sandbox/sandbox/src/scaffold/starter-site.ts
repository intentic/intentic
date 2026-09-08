import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { STARTER_APP, STARTER_REPO } from "@intentic/sandbox-contract";
import { REFERENCE_DIR } from "@intentic/workspace-ignore";
import { AGENT_GIT_AUTHOR } from "../git/git.js";
import { gitCommitAll, gitInit } from "@intentic/scaffold";
import type { Services } from "../composition.js";
import { repoGitDir, syncRootExcludes } from "../history/history.js";
import { discoverRepos } from "../workspace/layout/repo-discovery.js";
import { recordAutostart } from "./autostart.js";

const exec = promisify(execFile);

// What a brand-new sandbox shows in its first ten seconds: seeded here, started by the `autostart` boot step
// (autostart.ts) so every boot runs it, not only this one. Copied from the image's pre-built tree, never built here.
// Only on a fresh workspace the daemon owns (container/hosted profile), never over a user's own folder.

// Where the image bakes the monorepo; STARTER_REPO/STARTER_APP name what it becomes in the workspace.
export const STARTER_BAKED_DIR = "/opt/starter";

// Dotted, so the emptiness check treats it as daemon furniture and scanners skip it while it's written.
const STAGE_DIR = ".starter-site.incoming";

// The landing template's dev command, hardcoded to avoid a network clone of the manifest on first boot.
const STARTER_DEV = "pnpm --filter {pkg} dev";

// Whether disk content, not git history, is empty: a handed-in checkout has no history either but is not empty. Dotted
// entries are the daemon's own and are skipped; called once at composition, before this daemon writes anything.
export const workspaceArrivedEmpty = (root: string): boolean => {
    try {
        return readdirSync(root).every((entry) => entry.startsWith(".") || entry === REFERENCE_DIR);
    } catch {
        // No workspace root to read is not a workspace to seed into.
        return false;
    }
};

// Every skip names why: a once-per-sandbox seed cannot be re-run, so the reason must be legible from this boot's log
// alone.
export type StarterSkipped = "no baked starter in this image" | "a site repo is already there" | "the workspace arrived with content";
export type StarterOutcome = { readonly repo: string } | { readonly skipped: StarterSkipped };

// Copies the baked starter into the workspace and records it for autostart; returns the repo name or which of the three
// skip reasons applied. Failures are the caller's to log, never fatal to the boot; `bakedDir` is overridable only for
// tests.
export const seedStarterSite = async (services: Services, bakedDir: string = STARTER_BAKED_DIR): Promise<StarterOutcome> => {
    const target = join(services.workspace.root, STARTER_REPO);
    if (!existsSync(bakedDir)) {
        return { skipped: "no baked starter in this image" };
    }
    if (existsSync(target)) {
        return { skipped: "a site repo is already there" };
    }
    // Uses the verdict composition took, not a fresh directory read, avoiding a read-after-write race.
    if (!services.workspaceArrivedEmpty) {
        return { skipped: "the workspace arrived with content" };
    }
    // Staged then renamed atomically, so the existence gate below never sees a half-copied tree; a leftover stage from
    // a dead boot is discarded, not resumed. `cp -a`, not fs.cp, preserves pnpm's relative symlinks instead of
    // dereferencing them.
    const stage = join(services.workspace.root, STAGE_DIR);
    await rm(stage, { recursive: true, force: true });
    await exec("cp", ["-a", bakedDir, stage]);
    await rename(stage, target);
    // Git dir lives on /history, not /work, like every workspace repo, so Changes review reads it as a repo.
    await gitInit(target, repoGitDir(services.config.historyRoot, STARTER_REPO));
    await gitCommitAll(target, "chore: starter site", AGENT_GIT_AUTHOR);
    // Re-converges root's stale excludes so its imminent baseline commit does not swallow the site as a gitlink.
    await syncRootExcludes(services.config.historyRoot, await discoverRepos(services.workspace.root));
    // Only recorded when the app package exists; otherwise the entry would skip forever.
    if (existsSync(join(target, "_apps", STARTER_APP, "package.json"))) {
        await recordAutostart(services.workspace.root, { repo: STARTER_REPO, app: STARTER_APP, dev: STARTER_DEV });
    }
    return { repo: STARTER_REPO };
};
