import { existsSync } from "node:fs";
import { ONNX_SESSION_OPTIONS } from "./onnx-threads.js";

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
/** @alias */
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
        session_options: ONNX_SESSION_OPTIONS,
    });
    // One text per model call. A batch is padded to its longest member, and chunks run from one line to 1,200 chars,
    // so most of a batch's work was padding. Measured 2026-11-09 on this repository's chunks: batches of 16 embedded
    // 5.0 chunks per CPU-second with an 869 MB peak, one at a time 13.9 with 233 MB, vectors at cosine 0.99 or more
    // to the batched ones, within the int8 quantization the index stores them at.
    const embed = async (texts: readonly string[]): Promise<Float32Array[]> => {
        const vectors: Float32Array[] = [];
        for (const text of texts) {
            const tensor = await extractor(text, { pooling: POOLING, normalize: true });
            // SAFETY: feature-extraction with pooling yields a float32 tensor of one EMBEDDING_DIM row per input.
            const data = tensor.data as Float32Array;
            vectors.push(new Float32Array(data.buffer, data.byteOffset, EMBEDDING_DIM));
        }
        return vectors;
    };
    return {
        modelId: MODEL_ID,
        embedBatch: embed,
        embedQuery: async (query) => (await embed([`${QUERY_PREFIX}${query}`]))[0]!,
    };
};
