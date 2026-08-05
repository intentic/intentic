import { compareUnrankedModelIds, type Model } from "@intentic/sandbox-contract";
import type { CliProxyClient } from "../agent/translator.js";

/* Kimi Code's picker catalog. CLIProxyAPI owns both the subscription credential and the executor, so its
 * provider-scoped model definitions are the only catalog that can honestly describe what this pinned runtime
 * knows how to route. The endpoint is local and requires no inference from the multiplexed /v1/models owner.
 * A compile-time floor keeps the picker useful while the proxy is still booting; only a real answer is cached,
 * so the next read replaces that floor as soon as CLIProxyAPI is reachable. */
export interface KimiCatalog {
    readonly models: () => Promise<{ models: Model[]; default: string }>;
}

const MODELS_TTL_MS = 60_000;

const SEED_KIMI_MODELS: readonly Model[] = [
    { id: "kimi-k3", label: "Kimi K3", efforts: ["low", "high", "max"] },
    { id: "kimi-k3-256k", label: "Kimi K3 256K", efforts: ["low", "high", "max"] },
    { id: "kimi-k2.7-code", label: "Kimi K2.7 Code", efforts: ["low", "high"] },
    { id: "kimi-k2.7-code-highspeed", label: "Kimi K2.7 Code HighSpeed", efforts: ["low", "high"] },
];

const isChatModel = (model: Model): boolean => !/(embedding|whisper|tts|audio|vision-only|moderation|image-generation)/i.test(model.id);

// CLIProxyAPI publishes a set in registry order, not a preference order. Put the frontier generation first so
// the catalog's first row is also the default a turn receives when nothing was pinned.
const toCatalog = (models: readonly Model[]): { models: Model[]; default: string } => {
    const ordered = models.filter(isChatModel).toSorted((left, right) => compareUnrankedModelIds(left.id, right.id));
    return { models: ordered, default: ordered[0]!.id };
};

export const createKimiCatalog = (cliProxy: Pick<CliProxyClient, "models">): KimiCatalog => {
    let cache: { value: { models: Model[]; default: string }; expiresAt: number } | undefined;

    return {
        models: async () => {
            if (cache !== undefined && Date.now() < cache.expiresAt) {
                return cache.value;
            }
            const discovered = (await cliProxy.models("kimi").catch(() => [])).filter(isChatModel);
            if (discovered.length > 0) {
                const value = toCatalog(discovered);
                cache = { value, expiresAt: Date.now() + MODELS_TTL_MS };
                return value;
            }
            return toCatalog(SEED_KIMI_MODELS);
        },
    };
};
