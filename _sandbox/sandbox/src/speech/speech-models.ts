import type { SpeechEngine } from "@intentic/sandbox-contract";

// The model files behind each speech engine, pinned to an exact Hugging Face revision and checked byte for byte: k2-fsa's
// sherpa-onnx exports, int8. The image's `speech` pack bakes Parakeet's (image-packs/speech.Dockerfile, fetched by
// scripts/fetch-speech-models.mjs); anything not baked is fetched into the workspace cache the first time it is asked
// for (model-store.ts).

export interface SpeechModelFile {
    readonly path: string;
    readonly size: number;
    readonly sha256: string;
}

export interface SpeechModel {
    readonly engine: SpeechEngine;
    readonly repo: string;
    readonly revision: string;
    readonly files: readonly SpeechModelFile[];
    // Whether its phrase is worth re-hearing while it is still being spoken. Whisper takes about a third of real time
    // on two cores, so a running guess would cost more than the phrase; it answers once, at the end.
    readonly partials: boolean;
    // Whose model it is and under what licence: written beside the weights wherever they are baked.
    readonly attribution: string;
}

export const SPEECH_MODELS: Readonly<Record<SpeechEngine, SpeechModel>> = {
    parakeet: {
        engine: "parakeet",
        repo: "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
        revision: "2bda32ec70b097a55adaa07d9a7173915b43cc78",
        files: [
            { path: "encoder.int8.onnx", size: 652_184_281, sha256: "acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247" },
            { path: "decoder.int8.onnx", size: 11_845_275, sha256: "179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e" },
            { path: "joiner.int8.onnx", size: 6_355_277, sha256: "3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3" },
            { path: "tokens.txt", size: 93_939, sha256: "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d" },
        ],
        partials: true,
        attribution:
            "NVIDIA Parakeet TDT 0.6B v3 (https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3), CC-BY-4.0, exported to ONNX by k2-fsa/sherpa-onnx.",
    },
    whisper: {
        engine: "whisper",
        repo: "csukuangfj/sherpa-onnx-whisper-turbo",
        revision: "2ca6ff69fc878651b770880507669577ac41c2ff",
        files: [
            { path: "turbo-encoder.int8.onnx", size: 674_716_297, sha256: "b02dcdf54f348741e93fe732b67d933c8dcb6735655f710640143081db38878b" },
            { path: "turbo-decoder.int8.onnx", size: 361_080_764, sha256: "20accd02388482eb3a46bd615631adfdc85e1eb2c7db9ea3f02a40ffe6b81547" },
            { path: "turbo-tokens.txt", size: 816_730, sha256: "b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126" },
        ],
        partials: false,
        attribution:
            "OpenAI Whisper large-v3-turbo (https://huggingface.co/openai/whisper-large-v3-turbo), MIT, exported to ONNX by k2-fsa/sherpa-onnx.",
    },
};

export const modelBytes = (model: SpeechModel): number => model.files.reduce((total, file) => total + file.size, 0);

export const modelFileUrl = (model: SpeechModel, file: SpeechModelFile): string =>
    `https://huggingface.co/${model.repo}/resolve/${model.revision}/${file.path}`;

// Where the image bakes models, one directory per engine (image-packs/speech.Dockerfile).
export const BAKED_SPEECH_MODELS_DIR = "/opt/speech-models";
