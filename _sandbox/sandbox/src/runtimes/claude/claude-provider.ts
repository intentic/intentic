import { join } from "node:path";
import type { Logger } from "pino";
import { attemptProbe, type AgentAdapter, healthReady, healthUnavailable, healthUnknown } from "../../agent/providers/adapter.js";
import { authStateRelPath, type ProviderModule, providerAccountEntry } from "../../agent/providers/provider-module.js";
import { planHarnessTurn } from "../../agent/run/turn/turn-plan.js";
import type { Config } from "../../env.config.js";
import { type ClaudeStore, fileClaudeStore, startClaudeRefresh } from "./claude-credentials.js";
import { claudeOneShot } from "./claude-one-shot.js";
import { type ClaudeCatalog, createClaudeCatalog } from "./claude-models.js";
import { type ClaudeSeatStore, fileClaudeSeatStore } from "./claude-seats.js";
import { claudeAccountDoor } from "./claude-accounts.js";

// Everything Claude contributes to the daemon (aggregated via agent/provider-module.ts). Claude is the anchor module:
// its adapter is the Claude Code loop, which also serves Kimi and the routed providers under the claude-code harness.

export interface ClaudeSlice {
    // Claude subscription accounts, one <id>.json per account under .intentic/secrets/auth/claude.
    readonly claudeStore: ClaudeStore;
    // Accounts an org switched Claude Code off for (claude/seats.json); apart, since the record rewrites whole.
    readonly claudeSeats: ClaudeSeatStore;
    // Claude's model catalog, held directly too so this module's row and the account routes share one instance.
    readonly claudeModels: ClaudeCatalog;
}

export const createClaudeSlice = (input: {
    readonly config: Config;
    readonly authRoot: string;
    readonly workspaceRoot: string;
    readonly logger: Logger;
}): ClaudeSlice => {
    const claudeStore = fileClaudeStore(join(input.authRoot, "claude"), input.logger);
    return {
        claudeStore,
        claudeSeats: fileClaudeSeatStore(join(input.authRoot, "claude", "seats.json"), input.logger),
        claudeModels: createClaudeCatalog(claudeStore, input.config, input.workspaceRoot, join(input.authRoot, "claude", "models.json")),
    };
};

const CLAUDE_CODE_ADAPTER: AgentAdapter<"claude-code"> = {
    runtime: "claude-code",
    oneShot: claudeOneShot,
    preflight: (services, input, context, installed) => planHarnessTurn(services, input, context, installed),
    // In-process (Agent SDK, no CLI binary), so only a credential can be missing, and which one depends on the turn.
    // Answers the weaker question the picker needs: is any way in configured.
    health: async (services) => {
        if (services.config.anthropicApiKey !== "" || services.config.translator.url !== "") {
            return healthReady();
        }
        const accounts = await attemptProbe(() => services.claudeStore.list());
        if (accounts === undefined) {
            return healthUnknown();
        }
        return accounts.length > 0 ? healthReady() : healthUnavailable("Connect your Claude subscription in Sandbox ▸ Agent.");
    },
    holdsSession: (services, sessionId, cwd) => services.sessions.exists(cwd, sessionId),
};

export const claudeProvider: ProviderModule = {
    id: "claude",
    accounts: claudeAccountDoor,
    adapters: [CLAUDE_CODE_ADAPTER],
    catalog: (services) => services.claudeModels.models(),
    // A stored account, else the container credential; the same two rungs health takes, minus the translator (routed
    // only).
    ready: async (services) =>
        (await services.claudeStore.list()).length > 0 || services.config.claudeCodeOauthToken !== "" || services.config.anthropicApiKey !== "",
    boot: (services, role) => {
        // Rotates tokens on a quiet timer so a burst of turn starts doesn't trigger the refresh together.
        if (role.roots) {
            startClaudeRefresh(services.claudeStore);
        }
    },
    secretEntries: async (services) =>
        (await services.claudeStore.list()).map((account) =>
            providerAccountEntry("claude", "Claude", account.id, account.label, authStateRelPath("claude", `${account.id}.json`)),
        ),
};
