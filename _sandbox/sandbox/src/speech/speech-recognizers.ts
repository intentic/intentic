import { createRequire } from "node:module";
import { join } from "node:path";
import type { SpeechEngine } from "@intentic/sandbox-contract";

// The models in memory, in whichever process loads them: sherpa-onnx's prebuilt N-API addon over its own ONNX Runtime.
// The daemon never loads it itself; speech-worker.ts does, in a process of its own (speech-engine.ts says why). Kept
// apart from that entry so a test can hear a real phrase in-process.

// What one decode needs: which model, where its files are, how many cores it may take, and for Whisper the language to
// hold it to.
export interface RecognizerSpec {
    readonly engine: SpeechEngine;
    readonly dir: string;
    readonly threads: number;
    readonly language?: string;
}

// The slice of sherpa-onnx-node this reads, typed here because the package ships none.
interface OfflineStream {
    acceptWaveform(wave: { readonly samples: Float32Array; readonly sampleRate: number }): void;
}
interface OfflineRecognizer {
    createStream(): OfflineStream;
    decode(stream: OfflineStream): void;
    getResult(stream: OfflineStream): { readonly text: string };
    setConfig(config: unknown): void;
}
interface Sherpa {
    readonly OfflineRecognizer: new (config: unknown) => OfflineRecognizer;
}

const SAMPLE_RATE = 16_000;

// sherpa-onnx's recognizer config for one spec. Parakeet is a NeMo transducer that finds its language itself; Whisper
// is held to the asked one, or detects it when none was given.
export const recognizerConfig = ({ engine, dir, threads, language }: RecognizerSpec): unknown =>
    engine === "parakeet"
        ? {
              featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
              modelConfig: {
                  transducer: {
                      encoder: join(dir, "encoder.int8.onnx"),
                      decoder: join(dir, "decoder.int8.onnx"),
                      joiner: join(dir, "joiner.int8.onnx"),
                  },
                  tokens: join(dir, "tokens.txt"),
                  modelType: "nemo_transducer",
                  numThreads: threads,
                  provider: "cpu",
              },
          }
        : {
              featConfig: { sampleRate: SAMPLE_RATE, featureDim: 128 },
              modelConfig: {
                  whisper: {
                      encoder: join(dir, "turbo-encoder.int8.onnx"),
                      decoder: join(dir, "turbo-decoder.int8.onnx"),
                      language: language ?? "",
                      task: "transcribe",
                  },
                  tokens: join(dir, "turbo-tokens.txt"),
                  numThreads: threads,
                  provider: "cpu",
              },
          };

export interface Recognizers {
    // Loads the spec's model now, so the first phrase is not the one that waits for it.
    readonly load: (spec: RecognizerSpec) => void;
    // One phrase of 16 kHz mono samples to its text, as the model wrote it.
    readonly decode: (spec: RecognizerSpec, samples: Float32Array) => string;
}

export const createRecognizers = (): Recognizers => {
    // Loaded on first need: a sandbox that never dictates never maps the addon.
    let sherpa: Sherpa | undefined;
    const loaded = new Map<SpeechEngine, { readonly recognizer: OfflineRecognizer; config: string }>();

    const recognizerFor = (spec: RecognizerSpec): OfflineRecognizer => {
        const config = recognizerConfig(spec);
        const json = JSON.stringify(config);
        const held = loaded.get(spec.engine);
        if (held !== undefined) {
            // Only Whisper's language moves between phrases, and setConfig swaps it without reloading the weights.
            if (held.config !== json) {
                held.recognizer.setConfig(config);
                held.config = json;
            }
            return held.recognizer;
        }
        sherpa ??= createRequire(import.meta.url)("sherpa-onnx-node") as Sherpa;
        const recognizer = new sherpa.OfflineRecognizer(config);
        loaded.set(spec.engine, { recognizer, config: json });
        return recognizer;
    };

    return {
        load: (spec) => void recognizerFor(spec),
        decode: (spec, samples) => {
            const recognizer = recognizerFor(spec);
            const stream = recognizer.createStream();
            stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
            recognizer.decode(stream);
            return recognizer.getResult(stream).text;
        },
    };
};
