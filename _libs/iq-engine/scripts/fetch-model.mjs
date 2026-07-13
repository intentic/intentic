#!/usr/bin/env node
// Bakes the iq models into <dest> at Docker build time, so `iq ask` runs fully offline: the bge embedder
// (semantic retrieval) and the ms-marco cross-encoder (rerank stage). Downloads go through Hugging Face's Xet
// protocol (@huggingface/hub) — the CAS bridge denies anonymous plain-HTTP fetches of these artifacts — then
// Transformers.js re-instantiates everything to validate the exact offline layout the runtime consumes.
// Usage: node scripts/fetch-model.mjs <dest-dir>
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline as streamToFile } from "node:stream/promises";
import { downloadFile } from "@huggingface/hub";
import { AutoModelForSequenceClassification, AutoTokenizer, env, pipeline } from "@huggingface/transformers";

const dest = process.argv[2];
if (dest === undefined) {
    console.error("usage: fetch-model.mjs <dest-dir>");
    process.exit(2);
}

// Same model ids + dtypes as src/embed/{embedder,reranker}.ts, pinned to exact HF revisions.
const MODELS = {
    "Xenova/bge-small-en-v1.5": "ea104dacec62c0de699686887e3f920caeb4f3e3",
    "Xenova/ms-marco-MiniLM-L-6-v2": "a09144355adeed5f58c8ed011d209bf8ee5a1fec",
};
// Everything a q8 pipeline reads: tokenizer + config + the int8 onnx graph.
const FILES = ["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model_quantized.onnx"];

for (const [repo, revision] of Object.entries(MODELS)) {
    for (const file of FILES) {
        const blob = await downloadFile({ repo, path: file, revision });
        if (blob === null) {
            throw new Error(`${repo}@${revision} has no ${file}`);
        }
        const path = join(dest, repo, file);
        await mkdir(dirname(path), { recursive: true });
        await streamToFile(Readable.fromWeb(blob.stream()), createWriteStream(path));
    }
}

// Validate strictly offline — instantiating pulls every artifact the runtime needs, so a gap in FILES fails
// here with a clear local-file error instead of at first boot.
env.cacheDir = dest;
env.localModelPath = dest;
env.allowRemoteModels = false;
await pipeline("feature-extraction", "Xenova/bge-small-en-v1.5", { dtype: "q8" });
await AutoTokenizer.from_pretrained("Xenova/ms-marco-MiniLM-L-6-v2");
await AutoModelForSequenceClassification.from_pretrained("Xenova/ms-marco-MiniLM-L-6-v2", { dtype: "q8" });
console.log(`models cached in ${dest}`);
