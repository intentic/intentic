import { existsSync } from "node:fs";
import { ONNX_SESSION_OPTIONS } from "./onnx-threads.js";

const RERANKER_ID = "Xenova/ms-marco-MiniLM-L-6-v2";

export interface Reranker {
    // Cross-encoder relevance of each passage to the query, higher is better (raw logits, order is what matters).
    rerank(query: string, passages: readonly string[]): Promise<number[]>;
}

// Loads the baked cross-encoder from `modelDir` (offline only, like the embedder). undefined when absent:
// `ask` keeps its fused order, nothing else changes.
export const loadReranker = async (modelDir: string | undefined): Promise<Reranker | undefined> => {
    if (modelDir === undefined || modelDir === "" || !existsSync(modelDir)) {
        return undefined;
    }
    const { AutoModelForSequenceClassification, AutoTokenizer, env } = await import("@huggingface/transformers");
    env.localModelPath = modelDir;
    env.cacheDir = modelDir;
    env.allowRemoteModels = false;
    const tokenizer = await AutoTokenizer.from_pretrained(RERANKER_ID);
    const model = await AutoModelForSequenceClassification.from_pretrained(RERANKER_ID, {
        dtype: "q8",
        session_options: ONNX_SESSION_OPTIONS,
    });
    // One passage per model call. Code tokenizes densely, so a 1,200-char chunk often fills the 512-token limit, and
    // one batch of the whole pool was padded to 32 × 512. Measured 2026-11-09 on a pool of this repository's chunks:
    // batched, 2.5 CPU-seconds and a 566 MB peak (1,080 MB for long chunks); one at a time, 0.86 CPU-seconds and
    // 202 MB, three times faster, with logits within 0.1 of the batched ones.
    return {
        async rerank(query, passages) {
            const scores: number[] = [];
            for (const passage of passages) {
                const inputs = tokenizer(query, { text_pair: passage, truncation: true });
                // SAFETY: a sequence-classification head over one pair returns a single logit.
                const { logits } = (await model(inputs)) as { logits: { data: Float32Array } };
                scores.push(logits.data[0] ?? Number.NEGATIVE_INFINITY);
            }
            return scores;
        },
    };
};
