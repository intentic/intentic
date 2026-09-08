import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { gitCommitAll, INTENT_TSCONFIG, intentPackageJson } from "@intentic/scaffold";
import type { Services } from "../composition.js";
import { AGENT_GIT_AUTHOR, terminalGit } from "../git/git.js";
import { isDevBuild, version } from "../version.js";

const require = createRequire(import.meta.url);

// The sandbox's own version; the intent repo pins @intentic/{graph,sdk} to it, the same value /info reports.

// Package root of an installed @intentic/* package (dir holding its package.json), for `link:`. Resolves the main
// entry, then walks up, since the package's exports do not expose ./package.json directly.
const packageRoot = (pkg: string): string => {
    const entry = require.resolve(pkg);
    // Walks up to the package root; throws at the filesystem root instead of looping forever on a broken symlink.
    for (let dir = dirname(entry); ;) {
        if (existsSync(join(dir, "package.json"))) {
            return dir;
        }
        const parent = dirname(dir);
        if (parent === dir) {
            throw new Error(`no package.json above ${entry} for "${pkg}"`);
        }
        dir = parent;
    }
};

// A released image pins `~<version>` from the registry. A dev build's unpublished 0.0.0 packages aren't on npm, so it
// links to the copy bundled in this image instead.
export const dependencySpec = (pkg: string): string => (isDevBuild ? `link:${packageRoot(pkg)}` : `~${version}`);

// Installs @intentic/graph and @intentic/sdk into /work/intent so `resolve`/`apply` can import deploy.config.ts. Runs
// unconditionally: a presence gate would accept a half-finished install.
export const ensureIntentInstallable = async (services: Services, session: string): Promise<void> => {
    const intent = services.workspace.repos.intent;
    services.logger.info("wiring the intent repo for provisioning (pnpm install)…");
    await services.files.write(join(intent, "package.json"), intentPackageJson(dependencySpec("@intentic/graph"), dependencySpec("@intentic/sdk")));
    await services.files.write(join(intent, "tsconfig.json"), INTENT_TSCONFIG);
    await gitCommitAll(intent, "chore(intentic): wire intent repo for provisioning", AGENT_GIT_AUTHOR, terminalGit(services.terminalRun, session));
    const { code } = await services.terminalRun.tryRun(session, "pnpm install --ignore-workspace", { cwd: intent, window: "pnpm-install" });
    if (code !== 0) {
        services.logger.warn({ status: code }, "pnpm install failed; provisioning may not work until deps resolve");
    }
};
