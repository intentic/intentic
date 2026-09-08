import { join } from "node:path";
import { gitCommitAll, gitInit, INTENT_GITIGNORE, scaffoldDeployConfig, TARGET_GITIGNORE } from "@intentic/scaffold";
import type { Services } from "../composition.js";
import { AGENT_GIT_AUTHOR, terminalGit } from "../git/git.js";
import { repoGitDir } from "../history/history.js";
import { shellQuote } from "@intentic/sandbox-run/quote";
import { readTemplatesConfig } from "./templates-config.js";

// Capability-triggered repo scaffolding for devops/monorepo adds; UIs live in the web app's extensions, not an operator
// panel here. Shell (git bookkeeping, the monorepo CLI) runs in the caller's visible job session.

// Scaffolds an empty pnpm+turbo monorepo as its own repo at /work/<name> via the `intentic scaffold monorepo` CLI. UI
// is the web app's apps extension; the caller gates on existence for idempotency.
export const scaffoldAppMonorepo = async (services: Services, name: string, session: string): Promise<void> => {
    const { source, ref } = await readTemplatesConfig(services);
    await services.terminalRun.run(
        session,
        `intentic scaffold monorepo --dir ${shellQuote(services.workspace.root)} --name ${shellQuote(name)} --source ${shellQuote(source)} --ref ${shellQuote(ref)}`,
        { cwd: services.workspace.root, window: "scaffold" },
    );
};

// Scaffolds a neutral ledger: intent + desired-state repos with an empty deploy.config.ts and no app repo, so the
// sandbox is reachable with something to read but nothing provisioned. Idempotent via the caller's existsSync(intent)
// gate.
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

};
