import { join } from "node:path";
import type { Logger } from "pino";
import { attemptProbe, type AgentAdapter, healthReady, healthUnavailable, healthUnknown } from "../agent/adapter.js";
import { authStateRelPath, type ProviderModule, providerAccountEntry } from "../agent/provider-module.js";
import { planHarnessTurn } from "../agent/turn-plan.js";
import type { Config } from "../env.config.js";
import type { AccountUsageStore } from "../usage/account-usage.js";
import { type ClaudeUsageRefresher, createClaudeUsageRefresher } from "../usage/claude-usage.js";
import { type ClaudeStore, fileClaudeStore, startClaudeRefresh } from "./claude-credentials.js";
import { type ClaudeCatalog, createClaudeCatalog } from "./claude-models.js";
import { type ClaudeSeatStore, fileClaudeSeatStore } from "./claude-seats.js";

/* EVERYTHING CLAUDE CONTRIBUTES TO THE DAEMON, aggregated by the provider registry (agent/provider-module.ts
 * is the seam). Claude is the anchor module: its adapter is the Claude Code LOOP, which also serves Kimi (no
 * runtime of its own), the routed providers under the claude-code harness, and every endpoint capability — so
 * the loop's arm (planHarnessTurn) stays in turn-plan with the core, and this module contributes the row that
 * points at it. */

export interface ClaudeSlice {
    // Claude subscription accounts (one <id>.json per account under .intentic/secrets/auth/claude), several
    // per sandbox.
    readonly claudeStore: ClaudeStore;
    // Which of those accounts an organization has switched Claude Code off for (claude/seats.json, beside
    // them). Kept apart from the account record because that record is rewritten whole on every token
    // rotation, by every sandbox sharing the auth dir, see claude-seats.ts. The picker skips a refused seat.
    readonly claudeSeats: ClaudeSeatStore;
    // Keeps the Claude half of the account-usage store current for accounts NO turn is running on, the native
    // counterpart to cliProxy.refreshUsage. /claude/accounts waits on it (briefly) so a Usage tab reports what
    // claude.ai would report at that moment rather than what was true at the end of the last turn.
    readonly claudeUsage: ClaudeUsageRefresher;
    // Claude's model catalog (the Agent SDK probe with a persisted floor), held directly as well as in the
    // shared record so this module's row and the account routes read one instance.
    readonly claudeModels: ClaudeCatalog;
}

export const createClaudeSlice = (input: {
    readonly config: Config;
    readonly authRoot: string;
    readonly workspaceRoot: string;
    readonly logger: Logger;
    // Shared with the translator client, which records the routed subscriptions' readings into the same file:
    // headroom is one idea in this product, so the store is core and both halves write it.
    readonly accountUsage: AccountUsageStore;
}): ClaudeSlice => {
    const claudeStore = fileClaudeStore(join(input.authRoot, "claude"), input.logger);
    return {
        claudeStore,
        claudeSeats: fileClaudeSeatStore(join(input.authRoot, "claude", "seats.json"), input.logger),
        claudeUsage: createClaudeUsageRefresher({ store: claudeStore, usage: input.accountUsage }),
        claudeModels: createClaudeCatalog(claudeStore, input.config, input.workspaceRoot, join(input.authRoot, "claude", "models.json")),
    };
};

const CLAUDE_CODE_ADAPTER: AgentAdapter<"claude-code"> = {
    runtime: "claude-code",
    preflight: (services, input, context, installed) => planHarnessTurn(services, input, context, installed),
    /* The Claude Code loop is in-process (the Agent SDK, not a CLI), so there is no binary to look for and the
     * only thing that can be missing is the credential. Which credential depends on where the turn is pointed,
     * a routed provider rides the translator, a native Claude turn its own OAuth, and resolving that needs the
     * turn. So this answers the weaker question the picker actually needs: is ANY way in configured. */
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
    adapters: [CLAUDE_CODE_ADAPTER],
    catalog: (services) => services.claudeModels.models(),
    // A stored account, else the container's own credential — the same two rungs the health probe takes,
    // minus the translator (which serves the ROUTED providers, never a native Claude turn).
    ready: async (services) =>
        (await services.claudeStore.list()).length > 0 || services.config.claudeCodeOauthToken !== "" || services.config.anthropicApiKey !== "",
    boot: (services, role) => {
        // Rotate Claude subscription tokens on a quiet timer rather than letting a burst of turn starts
        // discover the expiry together. Anthropic rotates refresh tokens and revokes the whole family on a
        // replay, so the goal is for a turn to never be the thing that triggers a refresh; the locking in
        // claude-credentials is the backstop for when it is anyway.
        if (role.roots) {
            startClaudeRefresh(services.claudeStore);
        }
        // Read every Claude account's plan limits now, and every few minutes after. The account list waits on
        // its own sweep, so this is for the readings nobody is looking at: which account an unattributed turn
        // runs on is decided by what is on file (accountWithHeadroom), and before this the file only ever knew
        // about accounts that had recently run a turn, so an account another Claude Code had spent all week
        // still looked like the one with the most room.
        services.claudeUsage.start();
    },
    secretEntries: async (services) =>
        (await services.claudeStore.list()).map((account) =>
            providerAccountEntry("claude", "Claude", account.id, account.label, authStateRelPath("claude", `${account.id}.json`)),
        ),
};
