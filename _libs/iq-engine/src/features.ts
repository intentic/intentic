// Every retrieval stage is independently toggleable so pipeline configurations can be benchmarked against each
// other. Default = everything on; the disabled set travels into IqResult.features as run provenance.
export const FEATURES = ["bm25", "semantic", "rerank", "prf", "confidence", "symctx", "graph", "boosts", "pack"] as const;

export type Feature = (typeof FEATURES)[number];

// Comma-separated spec: if ANY token lacks a `-` prefix, the list is an exact allow-list ("bm25" = only BM25);
// if every token is `-x`, it's default-minus ("−rerank,−prf" = all except those). Unknown names are usage errors.
export const parseFeatures = (spec: string | undefined): ReadonlySet<Feature> => {
    if (spec === undefined || spec.trim() === "") {
        return new Set(FEATURES);
    }
    const tokens = spec
        .split(",")
        .map((token) => token.trim())
        .filter((token) => token !== "");
    for (const token of tokens) {
        const name = token.replace(/^-/, "");
        if (!(FEATURES as readonly string[]).includes(name)) {
            throw new Error(`iq: unknown feature "${name}" — known: ${FEATURES.join(", ")}`);
        }
    }
    const allowList = tokens.some((token) => !token.startsWith("-"));
    if (allowList) {
        return new Set(tokens.filter((token) => !token.startsWith("-")) as Feature[]);
    }
    const disabled = new Set(tokens.map((token) => token.slice(1)));
    return new Set(FEATURES.filter((feature) => !disabled.has(feature)));
};

export const disabledOf = (features: ReadonlySet<Feature>): Feature[] => FEATURES.filter((feature) => !features.has(feature));
