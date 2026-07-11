import { existsSync } from "node:fs";

export const MODEL_ID = "Xenova/bge-small-en-v1.5";
export const EMBEDDING_DIM = 384;

// BGE convention: the retrieval prefix goes on queries only, never on passages.
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

export interface Embedder {
    readonly modelId: string;
    embedBatch(texts: readonly string[]): Promise<Float32Array[]>;
    embedQuery(query: string): Promise<Float32Array>;
}

// Loads the baked ONNX model from `modelDir` (offline only — the sandbox must never fetch at runtime).
// undefined when no model dir is configured or present: the semantic tier degrades, everything else works.
export const loadEmbedder = async (modelDir: string | undefined): Promise<Embedder | undefined> => {
    if (modelDir === undefined || modelDir === "" || !existsSync(modelDir)) {
        return undefined;
    }
    const { env, pipeline } = await import("@huggingface/transformers");
    env.localModelPath = modelDir;
    env.cacheDir = modelDir;
    env.allowRemoteModels = false;
    const extractor = await pipeline("feature-extraction", MODEL_ID, { dtype: "q8" });
    const embed = async (texts: readonly string[]): Promise<Float32Array[]> => {
        const tensor = await extractor([...texts], { pooling: "mean", normalize: true });
        const data = tensor.data as Float32Array;
        return texts.map((_, i) => new Float32Array(data.buffer, data.byteOffset + i * EMBEDDING_DIM * 4, EMBEDDING_DIM));
    };
    return {
        modelId: MODEL_ID,
        embedBatch: embed,
        embedQuery: async (query) => (await embed([`${QUERY_PREFIX}${query}`]))[0]!,
    };
};
