import { join } from "node:path";
import type { Logger } from "pino";
import { attemptProbe, type AgentAdapter, healthReady, healthUnavailable, healthUnknown } from "../agent/adapter.js";
import { authStateRelPath, type ProviderModule, providerAccountEntry } from "../agent/provider-module.js";
import { planHarnessTurn } from "../agent/turn-plan.js";
import type { Config } from "../env.config.js";
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
    // Claude's model catalog (the Agent SDK probe with a persisted floor), held directly as well as in the
    // shared record so this module's row and the account routes read one instance.
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
    },
    secretEntries: async (services) =>
        (await services.claudeStore.list()).map((account) =>
            providerAccountEntry("claude", "Claude", account.id, account.label, authStateRelPath("claude", `${account.id}.json`)),
        ),
};
