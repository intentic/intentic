import { existsSync } from "node:fs";
import { EMBED_INTRA_OP_THREADS } from "./onnx-threads.js";

export const MODEL_ID = "Xenova/bge-small-en-v1.5";
const EMBEDDING_DIM = 384;

// Attention-masked mean over the token states, then L2 normalisation. bge's reference is the [CLS] token; iq-bench
// scored the two as a tie, and switching would re-embed every index (README, "Embeddings").
const POOLING = "mean";

// Names the vector space: everything a stored vector depends on besides its chunk text. The index (syncModel) and the
// vector cache both compare it, so a change empties both instead of mixing two spaces. It must gain a suffix (e.g.
// `#pooling=cls`) whenever the model, the pooling or the normalisation changes. The mean-pooled, L2-normalised config
// keeps the bare model id because that is what every existing cache and index already carries, so they stay warm. The
// query prefix stays out: it shapes only query vectors, which are never stored.
export const VECTOR_SPACE = MODEL_ID;

// BGE convention: the retrieval prefix goes on queries only, never on passages.
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

export interface Embedder {
    readonly modelId: string;
    embedBatch(texts: readonly string[]): Promise<Float32Array[]>;
    embedQuery(query: string): Promise<Float32Array>;
}

// Loads the baked ONNX model from `modelDir` (offline only, the sandbox must never fetch at runtime).
// undefined when no model dir is configured or present: the semantic tier degrades, everything else works.
export const loadEmbedder = async (modelDir: string | undefined): Promise<Embedder | undefined> => {
    if (modelDir === undefined || modelDir === "" || !existsSync(modelDir)) {
        return undefined;
    }
    const { env, pipeline } = await import("@huggingface/transformers");
    env.localModelPath = modelDir;
    env.cacheDir = modelDir;
    env.allowRemoteModels = false;
    const extractor = await pipeline("feature-extraction", MODEL_ID, {
        dtype: "q8",
        session_options: { intraOpNumThreads: EMBED_INTRA_OP_THREADS, interOpNumThreads: 1 },
    });
    const embed = async (texts: readonly string[]): Promise<Float32Array[]> => {
        const tensor = await extractor([...texts], { pooling: POOLING, normalize: true });
        const data = tensor.data as Float32Array;
        return texts.map((_, i) => new Float32Array(data.buffer, data.byteOffset + i * EMBEDDING_DIM * 4, EMBEDDING_DIM));
    };
    return {
        modelId: MODEL_ID,
        embedBatch: embed,
        embedQuery: async (query) => (await embed([`${QUERY_PREFIX}${query}`]))[0]!,
    };
};
