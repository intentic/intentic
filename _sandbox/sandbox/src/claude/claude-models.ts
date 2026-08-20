import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type Options, query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { CLAUDE_SEED_MODELS, type Model, type ModelBadge, ModelSchema } from "@intentic/sandbox-contract";
import { z } from "zod";
import type { Config } from "../env.config.js";
import { type ClaudeStore, ensureFreshToken } from "./claude-credentials.js";

/* Claude's model catalog for the picker, built from the TWO catalogs Anthropic publishes, because neither is
 * usable on its own:
 *
 *   1. The Agent SDK's supportedModels() control request, the TIER ALIASES the Claude Code CLI offers
 *      (default / opus[1m] / sonnet / haiku). This is the only source for per-model effort levels and capability
 *      badges, but it publishes no versioned id at all: every row is named for its tier ("Opus") with the version
 *      it currently resolves to buried in prose inside `description` ("Opus 4.8 with 1M context · …"). An alias
 *      also LAGS a release, `opus` kept resolving to claude-opus-4-8 after claude-opus-5 had shipped and was
 *      already serving turns, so a new model is simply unreachable through it, which is exactly how a shipped
 *      model went missing from this picker.
 *   2. Anthropic's REST /v1/models, read with the same account OAuth token, the account's authoritative list of
 *      VERSIONED ids, each carrying a versioned display name ("Claude Opus 5"). This is what makes a just-shipped
 *      model pickable, and the only place a version is published as a NAME rather than as prose.
 *
 * ONLY VERSIONED ROWS ARE OFFERED. A tier alias cannot tell the user which model will answer them: "Opus" names
 * a moving target that the CLI repoints on its own schedule, so the composer's chip, the transcript and any
 * later "which model wrote this?" all lose the one fact that matters. The aliases still earn their discovery,
 * they hand their effort levels and badges to the versioned rows of their own tier (withTierCapabilities), but
 * they never become rows themselves, and neither does the nameless "Default (recommended)" the CLI lists first.
 *
 * Fallback order, matching codex-catalog.ts and kimi-catalog.ts: the live merge; the persisted last-known-good
 * catalog, rewritten on every successful discovery; the compile-time seed floor. Only real (discovered) results
 * are cached, so an unreachable source is retried on the next read rather than pinning a degraded list for the
 * daemon's lifetime. Persisting whole model records rather than bare ids (codex/kimi persist ids, having nothing
 * else) keeps the display name and capabilities too, so a version that postdates this build survives a restart
 * with its presentation intact and the seed floor is genuinely last-resort.
 *
 * Everything either catalog reports is forwarded verbatim, the repo curates nothing about any model, so a
 * release or a rename needs no edit here. The OpenAI-compatible providers report ids only and render label-only;
 * see ModelSchema in the contract. */

// The hyphen-delimited segments both id tests below read. REST ids are hyphenated (claude-opus-5,
// claude-haiku-4-5-20251001); an alias id is one bare word, optionally with a context-window suffix (opus[1m]).
const segmentsOf = (id: string): string[] => id.split("-");

// A row names a version when a numeric segment sits in its id. Every REST row carries one and no alias does,
// including opus[1m], whose digit is a context window, not a version, and which the segment test therefore
// rejects the way it rejects `opus` itself.
const namesVersion = (model: Model): boolean => segmentsOf(model.id).some((segment) => /^\d+$/.test(segment));

// The tier an alias speaks for: its id up to the context-window suffix ("opus[1m]" → "opus"), which is exactly
// the segment every versioned id in that tier carries ("claude-opus-5"). "default" names no tier, so it lends
// its capabilities to nothing, the same reason it can never be a row.
const tierOf = (alias: Model): string => alias.id.split("[")[0]!;

// Effort levels and capability badges are published by supportedModels() ALONE, and against a TIER rather than a
// version, so dropping the alias rows would take the composer's effort control with them. Each versioned row
// inherits them from its tier's alias instead; a row that published its own keeps it, and a family the CLI
// offers no alias for simply carries none, which is the honest answer. `description` is deliberately NOT
// inherited: it is prose about the one version the alias currently resolves to, so on any other row it would be
// a false claim about that model.
const withTierCapabilities = (model: Model, aliases: readonly Model[]): Model => {
    if (model.efforts !== undefined || model.badges !== undefined) {
        return model;
    }
    const alias = aliases.find((candidate) => segmentsOf(model.id).includes(tierOf(candidate)));
    if (alias === undefined) {
        return model;
    }
    return {
        ...model,
        ...(alias.efforts !== undefined ? { efforts: alias.efforts } : {}),
        ...(alias.badges !== undefined ? { badges: alias.badges } : {}),
    };
};

const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models?limit=100";

// A streaming-input source that stays open (yields nothing) until aborted. supportedModels() is a control
// request, only available while streaming input, so the prompt must be an async iterable that keeps the session
// open long enough to ask, without ever sending a user turn.
async function* pendingInput(signal: AbortSignal): AsyncGenerator<SDKUserMessage> {
    await new Promise<void>((resolve) => {
        if (signal.aborted) {
            resolve();
            return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
    });
    // Nothing is ever sent, the empty delegation states that while satisfying the generator contract.
    yield* [];
}

// Ask the CLI for its available models over a throwaway streaming-input session, then dispose it. Throws when the
// CLI can't start / auth fails, the caller falls back to the persisted catalog, then the aliases.
const discoverClaudeModels = async (oauthToken: string | undefined, cwd: string): Promise<Model[]> => {
    const abort = new AbortController();
    const options: Options = {
        cwd,
        abortController: abort,
        env: {
            ...process.env,
            // Claude Code refuses to run under root unless the environment is marked already-sandboxed (this
            // container is), mirrors runAgent's baseOptions.
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

// The account's versioned catalog from Anthropic's REST /v1/models, authenticated with the SAME OAuth token the
// CLI runs on (the subscription credential enumerates there, so no API key is involved). `display_name` is
// already the versioned human name, so it rides straight into `label`, this is the row that finally puts a
// version in front of the user. [] on a missing token or any failure, so a caller keeps whatever the alias
// discovery returned instead of losing the catalog to a REST hiccup.
const discoverApiModels = async (oauthToken: string | undefined, fetchImpl: typeof fetch): Promise<Model[]> => {
    if (oauthToken === undefined) {
        return [];
    }
    const response = await fetchImpl(ANTHROPIC_MODELS_URL, {
        headers: {
            authorization: `Bearer ${oauthToken}`,
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "oauth-2025-04-20",
        },
    }).catch(() => undefined);
    if (response === undefined || !response.ok) {
        return [];
    }
    const json = (await response.json().catch(() => undefined)) as { data?: { id: string; display_name?: string }[] } | undefined;
    return (json?.data ?? []).map((model) => ({ id: model.id, label: model.display_name ?? model.id }));
};

// The versioned rows ARE the catalog; the aliases are mined for capabilities and then dropped. They ride in the
// REST catalog's own order (newest first), so models[0], the default a fresh chat lands on, is the newest
// model the account can actually drive, and no local ranking decides it. An alias reporting a versioned id
// leads (it brings metadata the REST row lacks) and dedups against it, so one source adopting the other's
// naming can only ever drop a duplicate row, never render the picker twice over.
const mergeCatalogs = (aliases: readonly Model[], versioned: readonly Model[]): Model[] => {
    const aliasVersions = aliases.filter(namesVersion);
    const seen = new Set(aliasVersions.map((model) => model.id));
    return [...aliasVersions, ...versioned.filter((model) => !seen.has(model.id))].map((model) => withTierCapabilities(model, aliases));
};

export interface ClaudeCatalog {
    // Claude's models (+ default id), never empty. accountId picks whose credential authenticates the CLI;
    // omitted ⇒ the first connected account (else the container CLAUDE_CODE_OAUTH_TOKEN fallback).
    readonly models: (accountId?: string) => Promise<{ models: Model[]; default: string }>;
}

// Models change rarely and the discovery spawns the CLI, so cache for the daemon's lifetime (a restart re-probes).
const MODELS_TTL_MS = 60 * 60_000;

// The provider's own first-listed model is the default, matching codex/grok/kimi, which all take ids[0]. Naming
// a tier here (the old /opus/i preference) would silently fall through to models[0] the moment Anthropic renamed
// its flagship, so the ordering the REST catalog already reports is both simpler and the one thing that stays
// correct.
const withDefault = (models: Model[]): { models: Model[]; default: string } => ({ models, default: models[0]!.id });

// `discover` and `fetchImpl` are injectable for the same reason codex/kimi inject `fetchImpl`: the real discovery
// spawns the Claude Code CLI, which inherits the ambient environment, so a test that merely withholds a token
// still reaches a live CLI on any developer machine that has one. Injecting both is what makes the fallback
// ladder assertable.
export const createClaudeCatalog = (
    claudeStore: ClaudeStore,
    config: Config,
    cwd: string,
    persistPath: string,
    discover: (oauthToken: string | undefined, cwd: string) => Promise<Model[]> = discoverClaudeModels,
    fetchImpl: typeof fetch = fetch,
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
            const token = await oauthToken(accountId);
            // Both catalogs answer for the same account and neither gates the other: one is a process spawn, the
            // other a fetch, so they run concurrently and either alone still yields a usable list.
            const [aliases, versioned] = await Promise.all([discover(token, cwd).catch(() => []), discoverApiModels(token, fetchImpl)]);
            const merged = mergeCatalogs(aliases, versioned);
            if (merged.length > 0) {
                await writePersisted(merged);
                const value = withDefault(merged);
                cache = { value, expiresAt: Date.now() + MODELS_TTL_MS };
                return value;
            }
            // No live catalog: serve the last-known-good, else the seed floor. Uncached either way, so both
            // sources are re-probed on the next read instead of pinning a degraded list for the daemon's lifetime.
            // The versioned test runs here too, the file is untrusted disk state (that is why it is schema-parsed
            // at all), so a record written by any other build can't put an unnameable row back in the picker.
            const persisted = (await readPersisted()).filter(namesVersion);
            return withDefault(persisted.length > 0 ? persisted : [...CLAUDE_SEED_MODELS]);
        },
    };
};
