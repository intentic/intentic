import { compareUnrankedModelIds, type Model } from "@intentic/sandbox-contract";
import { discoveredCatalog } from "../agent/model-catalog.js";
import type { CliProxyClient } from "../agent/translator.js";

/* Kimi Code's picker catalog. CLIProxyAPI owns both the subscription credential and the executor, so its
 * provider-scoped model definitions are the only catalog that can honestly describe what this pinned runtime
 * knows how to route. The endpoint is local and requires no inference from the multiplexed /v1/models owner.
 * A compile-time floor keeps the picker useful while the proxy is still booting, on the shared ladder
 * (agent/model-catalog.ts) with nothing persisted between: the proxy is local and answers within seconds of
 * boot, so a last-known-good file would only ever be a stale copy of it. */
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
    const catalog = discoveredCatalog({
        ttlMs: MODELS_TTL_MS,
        discover: async () => (await cliProxy.models("kimi").catch((): Model[] => [])).filter(isChatModel),
        toStored: (models: readonly Model[]) => [...models],
        seed: SEED_KIMI_MODELS,
        fromLive: toCatalog,
        fromStored: toCatalog,
    });
    return { models: catalog.models };
};
