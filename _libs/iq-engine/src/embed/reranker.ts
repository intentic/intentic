import { existsSync } from "node:fs";

export const RERANKER_ID = "Xenova/ms-marco-MiniLM-L-6-v2";

export interface Reranker {
    // Cross-encoder relevance of each passage to the query — higher is better (raw logits, order is what matters).
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
    const model = await AutoModelForSequenceClassification.from_pretrained(RERANKER_ID, { dtype: "q8" });
    return {
        async rerank(query, passages) {
            if (passages.length === 0) {
                return [];
            }
            const inputs = tokenizer(
                passages.map(() => query),
                { text_pair: [...passages], padding: true, truncation: true },
            );
            const { logits } = (await model(inputs)) as { logits: { data: Float32Array } };
            return [...logits.data];
        },
    };
};
