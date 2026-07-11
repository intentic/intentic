#!/usr/bin/env node
// Downloads the iq models into <dest> at Docker build time, so `iq ask` runs fully offline: the bge embedder
// (semantic retrieval) and the ms-marco cross-encoder (rerank stage).
// Usage: node scripts/fetch-model.mjs /opt/iq-models
import { AutoModelForSequenceClassification, AutoTokenizer, env, pipeline } from "@huggingface/transformers";

const dest = process.argv[2];
if (dest === undefined) {
    console.error("usage: fetch-model.mjs <dest-dir>");
    process.exit(2);
}
env.cacheDir = dest;
env.localModelPath = dest;
// Same model ids + dtypes as src/embed/{embedder,reranker}.ts — instantiating pulls every needed artifact.
await pipeline("feature-extraction", "Xenova/bge-small-en-v1.5", { dtype: "q8" });
await AutoTokenizer.from_pretrained("Xenova/ms-marco-MiniLM-L-6-v2");
await AutoModelForSequenceClassification.from_pretrained("Xenova/ms-marco-MiniLM-L-6-v2", { dtype: "q8" });
console.log(`models cached in ${dest}`);
