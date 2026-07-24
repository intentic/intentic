import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type Options, query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { type Model, type ModelBadge, ModelSchema } from "@intentic/sandbox-contract";
import { z } from "zod";
import type { Config } from "../env.config.js";
import { type ClaudeStore, ensureFreshToken } from "./claude-credentials.js";

/* Claude's model catalog for the picker, from the Agent SDK's supportedModels() control request — so new tiers
 * and accurate per-model effort levels appear with no code change. supportedModels() is only available in
 * streaming-input mode and spawns the Claude Code CLI, so it needs valid Claude auth. Source, in order, matching
 * codex-catalog.ts and kimi-catalog.ts:
 *   1. the live supportedModels() control request;
 *   2. the persisted last-known-good catalog, rewritten on every successful discovery;
 *   3. the compile-time tier-alias floor (opus/sonnet/haiku).
 * Only real (discovered) results are cached, so an unreachable CLI is retried on the next read rather than
 * pinning a degraded list for the daemon's lifetime.
 *
 * The persisted tier is what keeps a NEW TIER surviving a restart: the aliases track versions but name the tiers
 * we knew about at build time, so before persistence an offline restart silently lost a tier the CLI had already
 * reported. Persisting whole model records rather than bare ids (codex/kimi persist ids, having nothing else)
 * keeps the display name and description too — the alias floor is now genuinely last-resort, reached only before
 * the very first successful discovery.
 *
 * Claude is the ONLY provider whose discovery publishes presentation data: ModelInfo carries a versioned id, a
 * display name ("Claude Opus 4.8"), a capability description, effort tiers, and capability flags. All of it is
 * forwarded verbatim — the repo curates nothing about any model, so a release or a rename needs no edit here.
 * The OpenAI-compatible providers report ids only and render label-only; see ModelSchema in the contract. */

// The stable-alias fallback catalog, reached only before the first successful discovery ever persists. Aliases
// track the latest version of each tier, so this stays correct across version bumps; a brand-new TIER is missing
// only until the CLI is reachable once, after which the persisted catalog carries it across restarts.
const CLAUDE_ALIAS_MODELS: readonly Model[] = [
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
// CLI can't start / auth fails — the caller falls back to the persisted catalog, then the aliases.
const discoverClaudeModels = async (oauthToken: string | undefined, cwd: string): Promise<Model[]> => {
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
            const entry: Model = { id: model.value, label: model.displayName };
            if (model.supportedEffortLevels !== undefined) {
                entry.efforts = model.supportedEffortLevels;
            }
            if (model.description !== "") {
                entry.description = model.description;
            }
            // Badges are derived only from capability flags the SDK actually reports, so they can never claim
            // something about a model that Anthropic didn't. A model reporting neither flag simply has none.
            const badges: ModelBadge[] = [
                ...(model.supportsAdaptiveThinking === true ? (["reasoning"] as const) : []),
                ...(model.supportsFastMode === true ? (["fast"] as const) : []),
            ];
            if (badges.length > 0) {
                entry.badges = badges;
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
    readonly models: (accountId?: string) => Promise<{ models: Model[]; default: string }>;
}

// Models change rarely and the discovery spawns the CLI, so cache for the daemon's lifetime (a restart re-probes).
const MODELS_TTL_MS = 60 * 60_000;

// The provider's own first-listed model is the default — matching codex/grok/kimi, which all take ids[0]. Naming
// a tier here (the old /opus/i preference) would silently fall through to models[0] the moment Anthropic renamed
// its flagship, so the ordering the CLI already reports is both simpler and the one thing that stays correct.
const withDefault = (models: Model[]): { models: Model[]; default: string } => ({ models, default: models[0]!.id });

// `discover` is injectable for the same reason codex/kimi inject `fetchImpl`: the real one spawns the Claude Code
// CLI, which inherits the ambient environment — so a test that merely withholds a token still reaches a live CLI
// on any developer machine that has one. Injecting it is what makes the fallback ladder assertable.
export const createClaudeCatalog = (
    claudeStore: ClaudeStore,
    config: Config,
    cwd: string,
    persistPath: string,
    discover: (oauthToken: string | undefined, cwd: string) => Promise<Model[]> = discoverClaudeModels,
): ClaudeCatalog => {
    let cache: { value: { models: Model[]; default: string }; expiresAt: number } | undefined;

    // Parsed through the wire schema rather than trusted: the file is on disk across upgrades, so a record written
    // by an older build (or a truncated write) must degrade to the alias floor, never reach the picker half-formed.
    const readPersisted = async (): Promise<Model[]> => {
        try {
            const parsed = z.array(ModelSchema).safeParse(JSON.parse(await readFile(persistPath, "utf8")));
            return parsed.success ? parsed.data : [];
        } catch {
            return [];
        }
    };
    const writePersisted = async (models: Model[]): Promise<void> => {
        await mkdir(dirname(persistPath), { recursive: true });
        await writeFile(persistPath, JSON.stringify(models));
    };

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
            const discovered = await discover(await oauthToken(accountId), cwd).catch(() => []);
            if (discovered.length > 0) {
                await writePersisted(discovered);
                const value = withDefault(discovered);
                cache = { value, expiresAt: Date.now() + MODELS_TTL_MS };
                return value;
            }
            // No live catalog: serve the last-known-good, else the alias floor. Uncached either way, so the CLI is
            // re-probed on the next read instead of pinning a degraded list for the daemon's lifetime.
            const persisted = await readPersisted();
            return withDefault(persisted.length > 0 ? persisted : [...CLAUDE_ALIAS_MODELS]);
        },
    };
};
