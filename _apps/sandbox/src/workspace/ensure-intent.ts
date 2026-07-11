import { join } from "node:path";
import { gitCommitAll, INTENT_TSCONFIG, intentPackageJson } from "@intentic/scaffold";
import type { Services } from "../composition.js";
import { AGENT_GIT_AUTHOR, terminalGit } from "../git/git.js";
import { version } from "../version.js";

// The sandbox's own version — the intent repo pins @intentic/{graph,sdk} to it (published in the release image).
// It is the same value surfaced by /info as the exact release behind the moving stable image tag.

// Make the intent repo provisionable. `resolve` dynamically imports deploy.config.ts, which needs @intentic/graph
// and @intentic/sdk installed in /work/intent. The neutral first-boot ledger deliberately skips the skeleton +
// install so a reachability-only sandbox stays minimal and offline; a sandbox wired as a deploy target
// (SELF_HOST=1) calls this so `resolve`/`apply` work. Unconditional idempotent install (pnpm no-ops fast on a
// complete node_modules) — a presence gate would bless a half-install left by a mid-add restart. Published deps
// at the image's version (link=false) — the intent repo resolves @intentic/* from the registry. The install and
// the git bookkeeping run in the caller's visible job session.
export const ensureIntentInstallable = async (services: Services, session: string): Promise<void> => {
    const intent = services.workspace.repos.intent;
    services.logger.info("wiring the intent repo for provisioning (pnpm install)…");
    await services.files.write(join(intent, "package.json"), intentPackageJson(version, false));
    await services.files.write(join(intent, "tsconfig.json"), INTENT_TSCONFIG);
    await gitCommitAll(intent, "chore(intentic): wire intent repo for provisioning", AGENT_GIT_AUTHOR, terminalGit(services.terminalRun, session));
    const { code } = await services.terminalRun.tryRun(session, "pnpm install --ignore-workspace", { cwd: intent, window: "pnpm-install" });
    if (code !== 0) {
        services.logger.warn({ status: code }, "pnpm install failed; provisioning may not work until deps resolve");
    }
};
