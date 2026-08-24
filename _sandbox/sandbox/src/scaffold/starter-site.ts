import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { previewLabel, STARTER_APP, STARTER_REPO, zoneFromUrl } from "@intentic/sandbox-contract";
import { REFERENCE_DIR } from "@intentic/workspace-ignore";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { AGENT_GIT_AUTHOR } from "../git/git.js";
import { gitCommitAll, gitInit } from "@intentic/scaffold";
import type { Services } from "../composition.js";
import { repoGitDir, syncRootExcludes } from "../history/history.js";
import { appPanelKey, buildAppSpec } from "../workspace/app-previews.js";
import { discoverRepos } from "../workspace/repo-discovery.js";

const exec = promisify(execFile);

/* THE STARTER SITE: what a brand-new sandbox has to show for itself in its first ten seconds.
 *
 * A fresh workspace used to arrive empty, so the first thing a new user saw was an empty file tree and a chat
 * with nothing to talk about. The product's whole claim is "describe a change and watch it happen", and there
 * was nothing to change. So a fresh sandbox now opens with a real, running one-page site: something on screen
 * that is theirs, that the agent can edit, and that reloads while they watch.
 *
 * IT IS COPIED, NEVER BUILT HERE. The image bakes the whole monorepo — the same `intentic scaffold monorepo` +
 * `add-app landing` the Add-app button runs, node_modules and all (see the sandbox Dockerfile) — so this step
 * is a file copy and a dev-server start, not a template clone and a `pnpm install`. That is the difference
 * between a preview that is up before the user has finished reading the welcome and one that lands two minutes
 * later: an install cannot be made fast, so it is paid at image build time, once, for everybody.
 *
 * Only ever on a FRESH workspace, and only where the daemon owns the workspace (ownsWorkspaceConfig, i.e. the
 * container/hosted profile). A local daemon runs over a folder the user chose, and seeding a site into
 * somebody's own directory is exactly the litter the local posture promises not to leave. */

// Where the image bakes the ready-to-run monorepo. What it becomes in the workspace (STARTER_REPO /
// STARTER_APP) is declared in the contract package instead, because the browser has to name the same repo and
// app to put this site on screen when the user arrives.
export const STARTER_BAKED_DIR = "/opt/starter";

// Where the copy lands before it is renamed into place. DOTTED, and that is load-bearing twice over: the
// emptiness check below reads a dotted entry as the daemon's own furniture rather than as somebody's work (so a
// stage left by a dead boot cannot make the seed refuse to run for ever), and the workspace's scanners keep it
// out of the file tree while it is being written.
const STAGE_DIR = ".starter-site.incoming";

// The dev command for the baked app, which is the `landing` template's own preview command (templates.json:
// `pnpm --filter {pkg} dev`, no env, no sibling URLs). Written here rather than read from the template manifest
// because reading the manifest means cloning the source repo over the network, and a first boot that has a
// ready-to-run site on disk must not wait on GitHub to find out how to start it.
const STARTER_DEV = "pnpm --filter {pkg} dev";

/* DID THIS WORKSPACE ARRIVE EMPTY, asked of the disk rather than of the git dir. A fresh root repo is not the
 * same fact: a sandbox started over somebody's own checkout (their project handed in as the workspace) has no
 * history on /history either, so it reads as fresh on its first boot while being the one workspace a seeded
 * site would be pure litter in. Content is the honest signal, and the only content here yet is the daemon's
 * own: `.intentic`, the reference shelf, git's pointer, the agent config it converges later. Dotted entries are
 * therefore skipped and anything else at all means somebody brought their own work.
 *
 * ASKED ONCE, AT COMPOSITION, BEFORE THIS DAEMON HAS WRITTEN A BYTE INTO /work (composition.ts), and the
 * timing is the whole contract rather than a detail. The daemon writes into /work while it boots, and one of
 * those writes is NOT dotted: converging the skills index splices a managed block into `AGENTS.md`
 * (settings/loaded-skills.ts). On the desktop install path that convergence starts before the boot chain does,
 * off the setup computer's own card (main.ts seeds it detached, so the machine that ran the installer can
 * enroll), which on a real install landed AGENTS.md 40ms before this question was asked from inside the seed.
 * The seed then read the daemon's own file as "somebody brought their own work" and skipped the starter site,
 * silently, on every desktop install. Reading the answer before anything can write is what makes the verdict
 * about the USER's content instead of about who won a race. */
export const workspaceArrivedEmpty = (root: string): boolean => {
    try {
        return readdirSync(root).every((entry) => entry.startsWith(".") || entry === REFERENCE_DIR);
    } catch {
        // No workspace root to read is not a workspace to seed into.
        return false;
    }
};

/* WHAT THE SEED DID, in the caller's log. A skip used to be silent, and silence on a once-per-sandbox step is
 * unrecoverable evidence: the boot that was meant to seed happens once, cannot be re-run, and leaves nothing
 * behind that says why it didn't. Every skip is a sentence a reader can act on instead. */
export type StarterSkipped = "no baked starter in this image" | "a site repo is already there" | "the workspace arrived with content";
export type StarterOutcome = { readonly repo: string } | { readonly skipped: StarterSkipped };

// The `pnpm --filter` target: the baked app package's real name, which belongs to the template's scope and is
// the one thing here that must be read rather than assumed.
const starterPackage = (appDir: string): string | undefined => {
    try {
        const pkg = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")) as { name?: string };
        return pkg.name;
    } catch {
        return undefined;
    }
};

/* Put the baked starter into the workspace and start it. Answers the repo name when a site was seeded and the
 * reason when it was not, so the one boot where this matters says which of the three it was.
 *
 * Failures are the caller's to log and swallow: a sandbox with no starter site is a working sandbox with an
 * empty workspace, which is where every sandbox stood before this existed. Nothing here may take the boot
 * down.
 *
 * `bakedDir` is where the image put the tree, a parameter only so the tests can point it at one they built. */
export const seedStarterSite = async (services: Services, bakedDir: string = STARTER_BAKED_DIR): Promise<StarterOutcome> => {
    const target = join(services.workspace.root, STARTER_REPO);
    if (!existsSync(bakedDir)) {
        return { skipped: "no baked starter in this image" };
    }
    if (existsSync(target)) {
        return { skipped: "a site repo is already there" };
    }
    // The verdict the daemon took before it wrote anything of its own, never a fresh look at the directory:
    // see workspaceArrivedEmpty above for the race that reading it here loses.
    if (!services.workspaceArrivedEmpty) {
        return { skipped: "the workspace arrived with content" };
    }
    /* Copied ASIDE, then renamed into place. The seed's own existence gate is "is the repo there", so a boot
     * that died mid-copy (a killed machine, a full volume) would leave a half-written site that every later
     * boot then skips as already done: broken forever, silently. Staging makes the tree appear whole or not at
     * all, and the rename is atomic because both paths are on the same volume. A leftover stage from such a
     * death is thrown away rather than resumed, since nothing here knows how far it got.
     *
     * `cp -a` rather than fs.cp: the tree is a few hundred MB of node_modules with pnpm's relative symlinks
     * through it, and preserving those links (rather than dereferencing them into copies) is both correct and
     * an order of magnitude less work. */
    const stage = join(services.workspace.root, STAGE_DIR);
    await rm(stage, { recursive: true, force: true });
    await exec("cp", ["-a", bakedDir, stage]);
    await rename(stage, target);
    // Its own repo, shaped like every other workspace repo: git dir on /history, so an agent working in /work
    // cannot destroy the history, and the Changes review reads it as a repo rather than root's untracked pile.
    await gitInit(target, repoGitDir(services.config.historyRoot, STARTER_REPO));
    await gitCommitAll(target, "chore: starter site", AGENT_GIT_AUTHOR);
    // Root's excludes are DERIVED from the repos it can see, and they were written a step ago, before this one
    // existed. Re-converge them here, exactly as a clone does (git.routes.ts), or root's baseline commit, taken
    // moments from now, swallows the whole site as a gitlink and the Changes review opens on a phantom.
    await syncRootExcludes(services.config.historyRoot, await discoverRepos(services.workspace.root));

    const appDir = join(target, "_apps", STARTER_APP);
    const pkg = starterPackage(appDir);
    if (pkg === undefined) {
        return { repo: STARTER_REPO };
    }
    // The preview hostname before the dev server, and unawaited: a hostname must predate the first browser
    // lookup (an early NXDOMAIN is negative-cached for the zone's SOA TTL), and the platform round-trip that
    // mints it is not something a boot waits on.
    void services.ensurePreviewRoutes([previewLabel(appPanelKey(STARTER_REPO, STARTER_APP))]);
    await services.processes.start(
        appPanelKey(STARTER_REPO, STARTER_APP),
        buildAppSpec({
            repo: STARTER_REPO,
            repoDir: target,
            pkg,
            app: STARTER_APP,
            preview: { dev: STARTER_DEV },
            // Same pair the apps routes build preview URLs from. The landing template declares no env, so
            // nothing here reads them today; passing them keeps this start byte-identical to the button's.
            zone: services.config.zone !== "" ? services.config.zone : zoneFromUrl(services.config.sandbox.publicUrl),
            sandboxId: sandboxIdFromToken(services.config.connectToken),
        }),
    );
    return { repo: STARTER_REPO };
};
