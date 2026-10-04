import { whenAborted } from "@intentic/base/async";
import { discoveredCatalog } from "../../agent/models/model-catalog.js";
import { unrankedCatalog } from "../../agent/models/model-discovery.js";
import type { GoogleModelAvailability } from "../../agent/providers/google-model-availability.js";
import type { CliProxyClient } from "../../agent/providers/translator.js";
import type { Config } from "../../env.config.js";
import { cacheFile } from "../../store/open-document.js";
import { discoverGeminiModels, type GeminiModel, SEED_GEMINI_MODELS } from "./gemini-models.js";

export type GeminiModelSelection =
    { readonly ok: true; readonly model: string } | { readonly ok: false; readonly code?: "model-unavailable"; readonly message: string };

export interface GeminiCatalog {
    // Selectable models, not the translator's global advertisements; a verified empty pool stays empty.
    readonly models: () => Promise<{ models: GeminiModel[]; default: string }>;
    // Undefined means verification failed; [] is a verified catalog with no callable Google model.
    readonly live: () => Promise<readonly GeminiModel[] | undefined>;
    // Turns and helpers use one snapshot and never turn a missing pin into the default.
    readonly select: (model?: string) => Promise<GeminiModelSelection>;
}

// Cancelling one request ends its wait, not the shared refresh another picker/turn/helper may still need.
export const selectGeminiModelForRequest = async (
    catalog: Pick<GeminiCatalog, "select">,
    model: string | undefined,
    signal: AbortSignal,
): Promise<GeminiModelSelection> => {
    signal.throwIfAborted();
    const cancelled = Promise.withResolvers<never>();
    const unwatch = whenAborted(signal, () => cancelled.reject(signal.reason));
    try {
        const selection = Promise.resolve().then(() => {
            signal.throwIfAborted();
            return catalog.select(model);
        });
        const selected = await Promise.race([selection, cancelled.promise]);
        signal.throwIfAborted();
        return selected;
    } finally {
        unwatch();
    }
};

const MODELS_TTL_MS = 60_000;

const isGeminiModel = (entry: unknown): entry is GeminiModel => {
    const model = entry as { id?: unknown; label?: unknown; inputModalities?: unknown } | null;
    return (
        typeof model?.id === "string" &&
        typeof model.label === "string" &&
        Array.isArray(model.inputModalities) &&
        model.inputModalities.every((modality) => typeof modality === "string")
    );
};

interface GeminiSnapshot {
    readonly models: readonly GeminiModel[];
    readonly advertised: readonly GeminiModel[] | undefined;
    readonly availability: GoogleModelAvailability;
}

const verificationFailure = (): GeminiModelSelection => ({
    ok: false,
    message:
        "Google model availability could not be verified for every enabled account. Send again in a minute; your selected model has not been changed.",
});

// Pure selection boundary shared with the typed catalog fake: positive advertisements alone cannot authorize a pin.
export const selectGeminiModel = (snapshot: GeminiSnapshot, requested?: string): GeminiModelSelection => {
    const pinned = requested === undefined || requested === "" ? undefined : requested;
    const { availability } = snapshot;
    if (availability.state === "unknown") {
        return verificationFailure();
    }
    if (availability.accounts === 0) {
        return {
            ok: false,
            message:
                "No Google account is enabled in the model translator's rotation, so nothing can run on it. Check the Google account status in Sandbox ▸ Agent.",
        };
    }
    // A single verified omission is enough to disprove support across the whole rotating pool, even if another
    // account's metadata failed. An unreadable account alone never proves that the model is gone.
    const verified = availability.state === "verified" ? availability.accounts : availability.verified;
    if (pinned !== undefined && verified > 0 && !availability.models.includes(pinned)) {
        return {
            ok: false,
            code: "model-unavailable",
            message: `Google does not currently offer ${pinned} through this sandbox's enabled account pool. Pick an available model explicitly, or send again if it becomes available.`,
        };
    }
    if (availability.state === "incomplete") {
        return verificationFailure();
    }
    if (snapshot.advertised === undefined) {
        return {
            ok: false,
            message: "The model translator's Google catalog could not be verified. Send again in a minute; your selected model has not been changed.",
        };
    }
    if (pinned !== undefined && !snapshot.models.some((model) => model.id === pinned)) {
        return {
            ok: false,
            code: "model-unavailable",
            message: `Google's model translator is not currently advertising ${pinned} for this sandbox. Pick an available model explicitly, or send again if it becomes available.`,
        };
    }
    const model = pinned ?? unrankedCatalog(snapshot.models).default;
    if (model === "") {
        return {
            ok: false,
            message:
                "Google's enabled accounts and the model translator currently have no verified chat model in common. Send again in a minute, or choose a different provider explicitly.",
        };
    }
    return { ok: true, model };
};

export const createGeminiCatalog = (
    config: Config,
    persistPath: string,
    cliProxy: Pick<CliProxyClient, "googleModelAvailability">,
    fetchImpl: typeof fetch = fetch,
): GeminiCatalog => {
    // The shared ladder retains display metadata across outages and its disappearance grace. Keep the actual
    // advertisement separately so neither grace, persisted rows nor seeds become proof that an ID is routable.
    let advertised: { readonly models: readonly GeminiModel[]; readonly expiresAt: number } | undefined;
    const metadata = discoveredCatalog({
        ttlMs: MODELS_TTL_MS,
        discover: async () => {
            if (advertised !== undefined && Date.now() < advertised.expiresAt) {
                return advertised.models;
            }
            const models =
                config.translator.url === ""
                    ? undefined
                    : await discoverGeminiModels(config.translator.url, config.translator.token, fetchImpl).catch(() => undefined);
            advertised = models === undefined ? undefined : { models, expiresAt: Date.now() + MODELS_TTL_MS };
            return models ?? [];
        },
        idOf: (model) => model.id,
        store: cacheFile<GeminiModel[]>(persistPath, {
            parse: (raw) => (Array.isArray(raw) ? raw.filter(isGeminiModel) : undefined),
            fallback: () => [],
        }),
        toStored: (models) => [...models],
        seed: SEED_GEMINI_MODELS,
        fromLive: (models) => [...models],
        fromStored: (models) => [...models],
    });
    let pending: Promise<GeminiSnapshot> | undefined;
    const current = (): Promise<GeminiSnapshot> => {
        if (pending !== undefined) {
            return pending;
        }
        pending = (async () => {
            const [remembered, availability] = await Promise.all([
                metadata.models(),
                config.translator.url === ""
                    ? Promise.resolve<GoogleModelAvailability>({ state: "unknown" })
                    : cliProxy.googleModelAvailability().catch((): GoogleModelAvailability => ({ state: "unknown" })),
            ]);
            const routed = new Set(advertised?.models.map((model) => model.id));
            const eligible = new Set(availability.state === "verified" && availability.accounts > 0 ? availability.models : []);
            return {
                // Filter before ranking: a remembered frontier row must not outrank an actually available model.
                models: remembered.filter((model) => routed.has(model.id) && eligible.has(model.id)),
                advertised: advertised?.models,
                availability,
            };
        })().finally(() => {
            pending = undefined;
        });
        return pending;
    };
    return {
        models: async () => unrankedCatalog((await current()).models),
        live: async () => {
            const snapshot = await current();
            return snapshot.advertised === undefined || snapshot.availability.state !== "verified" ? undefined : snapshot.models;
        },
        select: async (model) => selectGeminiModel(await current(), model),
    };
};
