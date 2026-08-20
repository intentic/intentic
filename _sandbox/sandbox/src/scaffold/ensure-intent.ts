import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { gitCommitAll, INTENT_TSCONFIG, intentPackageJson } from "@intentic/scaffold";
import type { Services } from "../composition.js";
import { AGENT_GIT_AUTHOR, terminalGit } from "../git/git.js";
import { isDevBuild, version } from "../version.js";

const require = createRequire(import.meta.url);

// The sandbox's own version, the intent repo pins @intentic/{graph,sdk} to it (published in the release image).
// It is the same value surfaced by /info as the exact release behind the moving stable image tag.

// The package root of an installed @intentic/* package (the dir holding its package.json), for `link:`. Resolve
// its main entry (its exports don't expose ./package.json), then walk up to the package root. graph + sdk are
// direct deps of @intentic/sandbox exactly so this resolves, in the image from /opt/sandbox/node_modules, in
// local `pnpm dev` from the _libs symlinks.
const packageRoot = (pkg: string): string => {
    const entry = require.resolve(pkg);
    // Walk up from the resolved entry to its package root, stopping at the filesystem root. The resolve→root
    // invariant holds for a normally-installed package, but a broken/partial dev symlink could otherwise send
    // this synchronous loop past the root forever (dirname("/") === "/") and peg the daemon event loop, so
    // fail loudly at the root instead of spinning.
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

// The dependency spec for an @intentic/* package the intent repo needs. A released image carries a published
// version, so pin the `~<version>` range and resolve from the registry (portable, reviewable). A dev/:latest
// image carries the unpublished 0.0.0 sentinel, its packages aren't on npm, so `~0.0.0` can't resolve; link
// instead to the copy bundled in THIS image. The linked packages' own deps resolve from their bundled store
// siblings, so the intent repo's deploy.config.ts imports load under `resolve`.
export const dependencySpec = (pkg: string): string => (isDevBuild ? `link:${packageRoot(pkg)}` : `~${version}`);

// Make the intent repo provisionable. `resolve` dynamically imports deploy.config.ts, which needs @intentic/graph
// and @intentic/sdk installed in /work/intent. The neutral first-boot ledger deliberately skips the skeleton +
// install so a reachability-only sandbox stays minimal and offline; a sandbox wired as a deploy target
// (SELF_HOST=1) calls this so `resolve`/`apply` work. Unconditional idempotent install (pnpm no-ops fast on a
// complete node_modules), a presence gate would bless a half-install left by a mid-add restart. The install and
// the git bookkeeping run in the caller's visible job session.
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
