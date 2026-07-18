import { type Options, query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../env.config.js";
import { type ClaudeStore, ensureFreshToken } from "./claude-credentials.js";

/* Claude's model catalog for the picker, from the Agent SDK's supportedModels() control request — so new tiers
 * and accurate per-model effort levels appear with no code change. supportedModels() is only available in
 * streaming-input mode and spawns the Claude Code CLI, so it needs valid Claude auth; we cache it aggressively
 * (models change rarely) and fall back to the stable tier aliases (opus/sonnet/haiku) when it can't be reached
 * (offline / dev / no account) — the aliases already resolve to the newest version of each tier, so the fallback
 * is never wrong for a version bump, only missing a brand-new tier until the CLI is reachable. */

export interface ClaudeModel {
    id: string;
    label: string;
    efforts?: string[];
}

// The stable-alias fallback catalog. Aliases track the latest version of each tier, so the picker stays current
// for version bumps even without a live supportedModels() call.
const CLAUDE_ALIAS_MODELS: readonly ClaudeModel[] = [
    { id: "opus", label: "Opus" },
    { id: "sonnet", label: "Sonnet" },
    { id: "haiku", label: "Haiku" },
];

// A streaming-input source that stays open (yields nothing) until aborted. supportedModels() is a control
// request — only available while streaming input — so the prompt must be an async iterable that keeps the session
// open long enough to ask, without ever sending a user turn.
async function* pendingInput(signal: AbortSignal): AsyncGenerator<SDKUserMessage> {
    await new Promise<void>((resolve) => {
        if (signal.aborted) {
            resolve();
            return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
    });
    // Nothing is ever sent — the empty delegation states that while satisfying the generator contract.
    yield* [];
}

// Ask the CLI for its available models over a throwaway streaming-input session, then dispose it. Throws when the
// CLI can't start / auth fails — the caller falls back to the aliases.
const discoverClaudeModels = async (oauthToken: string | undefined, cwd: string): Promise<ClaudeModel[]> => {
    const abort = new AbortController();
    const options: Options = {
        cwd,
        abortController: abort,
        env: {
            ...process.env,
            // Claude Code refuses to run under root unless the environment is marked already-sandboxed (this
            // container is) — mirrors runAgent's baseOptions.
            IS_SANDBOX: "1",
            ...(oauthToken !== undefined ? { CLAUDE_CODE_OAUTH_TOKEN: oauthToken } : {}),
        },
    };
    const session = query({ prompt: pendingInput(abort.signal), options });
    try {
        return (await session.supportedModels()).map((model) => {
            const entry: ClaudeModel = { id: model.value, label: model.displayName };
            if (model.supportedEffortLevels !== undefined) {
                entry.efforts = model.supportedEffortLevels;
            }
            return entry;
        });
    } finally {
        abort.abort();
        await session.return(undefined).catch(() => {});
    }
};

export interface ClaudeCatalog {
    // Claude's models (+ default id), never empty. accountId picks whose credential authenticates the CLI;
    // omitted ⇒ the first connected account (else the container CLAUDE_CODE_OAUTH_TOKEN fallback).
    readonly models: (accountId?: string) => Promise<{ models: ClaudeModel[]; default: string }>;
}

// Models change rarely and the discovery spawns the CLI, so cache for the daemon's lifetime (a restart re-probes).
const MODELS_TTL_MS = 60 * 60_000;

// Prefer the Opus tier as the default (the product default), else the first offered model.
const withDefault = (models: ClaudeModel[]): { models: ClaudeModel[]; default: string } => ({
    models,
    default: (models.find((model) => /opus/i.test(model.id) || /opus/i.test(model.label)) ?? models[0]!).id,
});

export const createClaudeCatalog = (claudeStore: ClaudeStore, config: Config, cwd: string): ClaudeCatalog => {
    let cache: { value: { models: ClaudeModel[]; default: string }; expiresAt: number } | undefined;

    const oauthToken = async (accountId?: string): Promise<string | undefined> => {
        const id = accountId ?? (await claudeStore.list())[0]?.id;
        if (id !== undefined) {
            const token = await ensureFreshToken(claudeStore, id).catch(() => undefined);
            if (token !== undefined) {
                return token;
            }
        }
        return config.claudeCodeOauthToken !== "" ? config.claudeCodeOauthToken : undefined;
    };

    return {
        models: async (accountId) => {
            if (cache !== undefined && Date.now() < cache.expiresAt) {
                return cache.value;
            }
            const discovered = await discoverClaudeModels(await oauthToken(accountId), cwd).catch(() => []);
            if (discovered.length > 0) {
                const value = withDefault(discovered);
                cache = { value, expiresAt: Date.now() + MODELS_TTL_MS };
                return value;
            }
            // Uncached alias fallback so a reachable CLI is retried on the next read.
            return withDefault([...CLAUDE_ALIAS_MODELS]);
        },
    };
};
