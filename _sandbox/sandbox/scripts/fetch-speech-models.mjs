#!/usr/bin/env node
// Fetches the speech models the image bakes (image-packs/speech.Dockerfile) into <dest>/<engine>/, at the exact
// revisions and digests the daemon pins in src/speech/speech-models.ts, which this imports rather than repeats: Node
// strips that file's types itself, and it holds nothing but data. Run once per trees context by
// _tools/scripts/image/prepare-image-trees.sh; a file already present at its pinned digest is not fetched again.
// Usage: node scripts/fetch-speech-models.mjs <dest-dir> [engine...]   (default: parakeet)
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { modelFileUrl, SPEECH_MODELS } from "../src/speech/speech-models.ts";

const [dest, ...asked] = process.argv.slice(2);
if (dest === undefined) {
    console.error("usage: fetch-speech-models.mjs <dest-dir> [engine...]");
    process.exit(2);
}
const engines = asked.length === 0 ? ["parakeet"] : asked;

const digestOf = (path) =>
    new Promise((resolve) => {
        const hash = createHash("sha256");
        createReadStream(path)
            .on("data", (chunk) => hash.update(chunk))
            .on("end", () => resolve(hash.digest("hex")))
            .on("error", () => resolve(undefined));
    });

for (const engine of engines) {
    const model = SPEECH_MODELS[engine];
    if (model === undefined) {
        throw new Error(`no speech model named ${engine}; known: ${Object.keys(SPEECH_MODELS).join(", ")}`);
    }
    const dir = join(dest, engine);
    await mkdir(dir, { recursive: true });
    for (const file of model.files) {
        const target = join(dir, file.path);
        if ((await digestOf(target)) === file.sha256) {
            continue;
        }
        const part = `${target}.part`;
        const response = await fetch(modelFileUrl(model, file));
        if (!response.ok || response.body === null) {
            throw new Error(`${model.repo}@${model.revision}/${file.path}: Hugging Face answered ${response.status}`);
        }
        await pipeline(Readable.fromWeb(response.body), createWriteStream(part));
        const digest = await digestOf(part);
        if (digest !== file.sha256) {
            await rm(part, { force: true });
            throw new Error(`${file.path} arrived with sha256 ${digest}, pinned ${file.sha256}`);
        }
        await rename(part, target);
        console.log(`speech model ${engine}/${file.path}: ${(file.size / 1_048_576).toFixed(1)} MiB, sha256 ok`);
    }
    // The attribution the models' CC-BY-4.0 licence asks for, beside the weights it covers.
    await writeFile(join(dir, "NOTICE"), `${model.attribution}\nhttps://huggingface.co/${model.repo}/tree/${model.revision}\n`);
}
console.log(`speech models in ${dest}: ${engines.join(", ")}`);
