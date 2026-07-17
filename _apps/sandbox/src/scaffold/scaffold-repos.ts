import { join } from "node:path";
import { gitCommitAll, gitInit, INTENT_GITIGNORE, scaffoldDeployConfig, TARGET_GITIGNORE } from "@intentic/scaffold";
import type { Services } from "../composition.js";
import { AGENT_GIT_AUTHOR, terminalGit } from "../git/git.js";
import { repoGitDir } from "../history/history.js";
import { shellQuote } from "../terminal/terminal-run.js";
import { readTemplatesConfig } from "./templates-config.js";

// Capability-triggered repo scaffolding (devops / monorepo adds). The repos' UIs live in the web app's
// extensions — no operator panel is scaffolded into them here. All shell (git bookkeeping, the monorepo CLI)
// runs through the caller's visible job session so the user watches the actual commands.

// Scaffold an empty pnpm+turbo monorepo as its OWN repo at repositories/<name> by running the `intentic
// monorepo` CLI (the same @intentic/scaffold path, add-apps style — one visible command doing the template
// clone + shell layout + git init). Its UI is the web app's apps extension — no operator panel is scaffolded.
// The caller (the monorepo capability) gates on existence for idempotency.
export const scaffoldAppMonorepo = async (services: Services, name: string, session: string): Promise<void> => {
    await services.files.mkdir(services.workspace.repositories);
    const { source, ref } = await readTemplatesConfig(services);
    await services.terminalRun.run(
        session,
        `intentic monorepo --dir ${shellQuote(services.workspace.repositories)} --name ${shellQuote(name)} --source ${shellQuote(source)} --ref ${shellQuote(ref)}`,
        { cwd: services.workspace.repositories, window: "scaffold" },
    );
    // Mint the preview route NOW, not at first start — the hostname must exist long before a browser resolves
    // it, or the early NXDOMAIN gets negative-cached for the zone's SOA TTL. (Covers a root dev script; the
    // per-app routes mint at addApps.)
    void services.ensurePreviewRoute(name);
};

// Scaffold of a NEUTRAL ledger: the intent + desired-state git repos with an empty deploy.config.ts (only the
// managed `// <intentic>` region) and NO app repo — the sandbox is reachable and its inventory / source-control
// have something to read, but nothing is provisioned. No host, no app, no `intentic init`. Provisioning
// readiness (the intent repo's @intentic deps + install, and an app) is added later by the "Deploy on this
// machine" flow. Idempotent via the caller's `existsSync(intent)` gate.
export const scaffoldNeutralLedger = async (services: Services, session: string): Promise<void> => {
    const intent = services.workspace.repos.intent;
    const desiredState = services.workspace.repos["desired-state"];
    const git = terminalGit(services.terminalRun, session);

    await gitInit(intent, repoGitDir(services.config.historyRoot, "intent"), git);
    await services.files.write(join(intent, "deploy.config.ts"), scaffoldDeployConfig([]));
    await services.files.write(join(intent, ".gitignore"), INTENT_GITIGNORE);
    await gitCommitAll(intent, "chore(intentic): scaffold neutral ledger", AGENT_GIT_AUTHOR, git);

    await gitInit(desiredState, repoGitDir(services.config.historyRoot, "desired-state"), git);
    await services.files.write(join(desiredState, ".gitignore"), TARGET_GITIGNORE);
    await gitCommitAll(desiredState, "chore(intentic): scaffold desired-state", AGENT_GIT_AUTHOR, git);

    // Mint both preview routes at scaffold time (see scaffoldAppMonorepo's note on DNS negative caching).
    void services.ensurePreviewRoute("intent");
    void services.ensurePreviewRoute("desired-state");
};
