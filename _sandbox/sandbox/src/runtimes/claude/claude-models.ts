import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { sdk } from "./claude-sdk.js";
import { CLAUDE_SEED_MODELS, type Model, type ModelBadge, ModelSchema } from "@intentic/sandbox-contract";
import { z } from "zod";
import { discoveredCatalog } from "../../agent/models/model-catalog.js";
import type { Config } from "../../env.config.js";
import { jsonFile } from "../../store/json-file.js";
import { type ClaudeStore, ensureFreshToken } from "./claude-credentials.js";

// Claude's model catalog merges the CLI's tier aliases (effort levels and badges, no versioned id) with Anthropic's
// REST /v1/models (versioned ids and names); only versioned rows are offered, aliases just lend capabilities and are
// dropped. Ladder: live merge, persisted last-known-good, seed floor.

// Hyphen-delimited segments of an id. REST ids are hyphenated (claude-opus-5); an alias is one bare word, optionally
// with a context-window suffix (opus[1m]).
const segmentsOf = (id: string): string[] => id.split("-");

// A row names a version when a numeric segment sits in its id; opus[1m]'s digit is a context window, not a version, so
// it's rejected like any other alias.
const namesVersion = (model: Model): boolean => segmentsOf(model.id).some((segment) => /^\d+$/.test(segment));

// Tier an alias speaks for: its id up to the context-window suffix (opus[1m] to opus), matching the segment every
// versioned id in that tier carries. 'default' names no tier.
const tierOf = (alias: Model): string => alias.id.split("[")[0]!;

// Efforts and badges come only per tier; a versioned row inherits them from its alias unless it has its own.
// description is not inherited: it names one version.
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

// Stays open, yielding nothing, until aborted. supportedModels() is a control request available only while streaming
// input, so the session must be kept open without a user turn.
async function* pendingInput(signal: AbortSignal): AsyncGenerator<SDKUserMessage> {
    await new Promise<void>((resolve) => {
        if (signal.aborted) {
            resolve();
            return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
    });
    // Nothing is ever sent; the empty delegation just satisfies the generator contract.
    yield* [];
}

// Asks the CLI for its models over a throwaway streaming session, then disposes it. Throws on start/auth failure, so
// the caller falls back to the persisted catalog, then the aliases.
const discoverClaudeModels = async (oauthToken: string | undefined, cwd: string): Promise<Model[]> => {
    const abort = new AbortController();
    const options: Options = {
        cwd,
        abortController: abort,
        env: {
            ...process.env,
            // Claude Code refuses to run under root unless the environment is marked already-sandboxed.
            IS_SANDBOX: "1",
            ...(oauthToken !== undefined ? { CLAUDE_CODE_OAUTH_TOKEN: oauthToken } : {}),
        },
    };
    const session = sdk().query({ prompt: pendingInput(abort.signal), options });
    try {
        return (await session.supportedModels()).map((model) => {
            const entry: Model = { id: model.value, label: model.displayName };
            if (model.supportedEffortLevels !== undefined) {
                entry.efforts = model.supportedEffortLevels;
            }
            if (model.description !== "") {
                entry.description = model.description;
            }
            // Badges come only from capability flags the SDK reports; a model with neither flag has none.
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

// Versioned catalog from Anthropic's REST /v1/models, using the same OAuth token the CLI runs on; display_name rides
// straight into label. Returns [] on a missing token or any failure, so a REST hiccup never loses the alias catalog.
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

// Versioned rows are the catalog, in the REST order (newest first), so models[0] is the newest model with no local
// ranking. An alias reporting a versioned id leads and dedups against the REST row, so a shared id renders once.
const mergeCatalogs = (aliases: readonly Model[], versioned: readonly Model[]): Model[] => {
    const aliasVersions = aliases.filter(namesVersion);
    const seen = new Set(aliasVersions.map((model) => model.id));
    return [...aliasVersions, ...versioned.filter((model) => !seen.has(model.id))].map((model) => withTierCapabilities(model, aliases));
};

export interface ClaudeCatalog {
    // Never empty; accountId picks the credential, else the first connected account or the container token.
    readonly models: (accountId?: string) => Promise<{ models: Model[]; default: string }>;
}

// Discovery spawns the CLI and models change rarely, so this caches for the daemon's life; a restart re-probes.
const MODELS_TTL_MS = 60 * 60_000;

// Default is the provider's own first-listed model. Naming a tier here would silently break the moment Anthropic
// renames its flagship; list order is the only thing that stays correct.
const withDefault = (models: readonly Model[]): { models: Model[]; default: string } => ({ models: [...models], default: models[0]!.id });

// discover and fetchImpl are injectable: the real discovery spawns the CLI, which inherits the ambient environment, so
// withholding a token alone doesn't stop a test reaching a live CLI.
export const createClaudeCatalog = (
    claudeStore: ClaudeStore,
    config: Config,
    cwd: string,
    persistPath: string,
    discover: (oauthToken: string | undefined, cwd: string) => Promise<Model[]> = discoverClaudeModels,
    fetchImpl: typeof fetch = fetch,
): ClaudeCatalog => {
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

    const catalog = discoveredCatalog({
        ttlMs: MODELS_TTL_MS,
        // Both sources answer for the same account and run concurrently; either alone still yields a usable list.
        discover: async (accountId?: string) => {
            const token = await oauthToken(accountId);
            const [aliases, versioned] = await Promise.all([discover(token, cwd).catch(() => []), discoverApiModels(token, fetchImpl)]);
            return mergeCatalogs(aliases, versioned);
        },
        idOf: (model) => model.id,
        // Parsed through the schema, not trusted; an older or truncated record degrades to the floor, not a half-row.
        store: jsonFile<Model[]>(persistPath, { parse: (raw) => z.array(ModelSchema).safeParse(raw).data?.filter(namesVersion), fallback: () => [] }),
        toStored: (models) => [...models],
        seed: CLAUDE_SEED_MODELS,
        fromLive: withDefault,
        fromStored: withDefault,
    });
    return { models: catalog.models };
};
