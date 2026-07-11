import { type Feature, parseFeatures } from "@intentic/iq-engine";

// Named pipeline configurations the tier-1 sweep compares. `spec` uses iq's --features syntax
// (allow-list or default-minus) so provenance in IqResult.features matches real CLI usage.
export interface BenchConfig {
    readonly name: string;
    readonly spec?: string;
    readonly features: ReadonlySet<Feature>;
}

const config = (name: string, spec?: string): BenchConfig => ({
    name,
    ...(spec !== undefined ? { spec } : {}),
    features: parseFeatures(spec),
});

export const CONFIGS: readonly BenchConfig[] = [
    config("full"),
    config("no-semantic", "-semantic"),
    config("no-rerank", "-rerank"),
    config("no-prf", "-prf"),
    config("no-shaping", "-boosts,-symctx,-graph"),
    config("no-pack", "-pack"),
    config("lexical", "-semantic,-rerank,-prf"),
    config("bm25-only", "bm25"),
];

// Configs keeping semantic/rerank stages need the embedding models on disk; without them the engine would
// silently degrade — the bench marks such configs "skipped" instead.
export const needsModels = (bench: BenchConfig): boolean => bench.features.has("semantic") || bench.features.has("rerank");
