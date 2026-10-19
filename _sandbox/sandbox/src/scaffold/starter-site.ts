import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { appendFile, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { STARTER_APP, STARTER_REPO } from "@intentic/sandbox-contract/state/starter";
import { REFERENCE_DIR } from "@intentic/workspace-ignore";
import { AGENT_GIT_AUTHOR } from "../git-identity.js";
import { gitCommitAll, gitInit } from "@intentic/base/git";
import { undefinedIfMissing } from "@intentic/base/errors";
import type { Services } from "../composition.js";
import { repoGitDir, syncRootExcludes } from "../workspace/layout/git-layout.js";
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

// The baked install was made against the image's pnpm store, on the image's filesystem. /work is another one, and there
// pnpm picks a store of its own (`<mount>/.pnpm-store`), finds the modules made with a different store, and asks to
// remove and reinstall every project's modules: the prompt a fresh starter's first `pnpm … typecheck` sat on, unseen in
// an agent's pane. So the seeded workspace names the store its modules came from, and never asks before a purge it
// does need (pnpm 11 reads both only from pnpm-workspace.yaml: not .npmrc, and `confirmModulesPurge` not from env).
const MODULES_MANIFEST = join("node_modules", ".modules.yaml");
const WORKSPACE_MANIFEST = "pnpm-workspace.yaml";

// The store directory a pnpm modules manifest records, without the layout version pnpm appends (`…/store/v11`).
export const bakedStoreDir = (manifest: string): string | undefined => {
    const match = /"storeDir":\s*"([^"]+)"|^storeDir:\s*(\S+)\s*$/m.exec(manifest);
    const recorded = match?.[1] ?? match?.[2];
    return recorded?.replace(/\/v\d+\/?$/, "");
};

// What the seeded pnpm-workspace.yaml gains: only the keys it does not already set.
export const storePinLines = (workspaceYaml: string, storeDir: string | undefined): string[] => {
    const sets = (key: string): boolean => new RegExp(`^${key}:`, "m").test(workspaceYaml);
    return [
        ...(storeDir === undefined || sets("storeDir") ? [] : [`storeDir: ${storeDir}`]),
        ...(sets("confirmModulesPurge") ? [] : ["confirmModulesPurge: false"]),
    ];
};

const pinBakedStore = async (repo: string): Promise<void> => {
    const workspaceYaml = join(repo, WORKSPACE_MANIFEST);
    if (!existsSync(workspaceYaml)) {
        return;
    }
    const manifest = (await readFile(join(repo, MODULES_MANIFEST), "utf8").catch(undefinedIfMissing)) ?? "";
    const current = await readFile(workspaceYaml, "utf8");
    const lines = storePinLines(current, bakedStoreDir(manifest));
    if (lines.length === 0) {
        return;
    }
    const lead = current === "" || current.endsWith("\n") ? "" : "\n";
    const note = "# Set when intentic seeded this site: its modules were installed into the image's pnpm store, so pnpm\n# keeps using it rather than asking to reinstall them, and never stops to ask before removing modules.\n";
    await appendFile(workspaceYaml, `${lead}\n${note}${lines.join("\n")}\n`);
};

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
export const seedStarterSite = async (
    services: Pick<Services, "config" | "workspace" | "workspaceArrivedEmpty">,
    bakedDir: string = STARTER_BAKED_DIR,
): Promise<StarterOutcome> => {
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
    await pinBakedStore(stage);
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
