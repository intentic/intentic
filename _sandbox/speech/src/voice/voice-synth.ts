import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { LocalVoiceKind } from "./voice-models.js";

// The voice models in memory, in whichever process loads them: sherpa-onnx's prebuilt N-API addon, the one dictation
// loads. The daemon never loads it itself; voice-worker.ts does, in a process of its own (voice-process.ts says why).
// Kept apart from that entry so a test can speak a real sentence in-process.

// What one utterance needs: which model, where its files are, and how many cores it may take.
export interface SynthSpec {
    readonly kind: LocalVoiceKind;
    readonly model: string;
    readonly dir: string;
    readonly threads: number;
}

// One sentence to say: which speaker of the model, how fast, and for Kokoro the language its phonemizer reads it as.
export interface SynthAsk {
    readonly text: string;
    readonly sid: number;
    readonly speed: number;
    readonly lang?: string;
}

export interface Synthesized {
    readonly samples: Float32Array;
    readonly sampleRate: number;
}

// The slice of sherpa-onnx-node this reads, typed here because the package ships none.
interface KokoroModelConfig {
    readonly model: string;
    readonly voices: string;
    readonly tokens: string;
    readonly dataDir: string;
    readonly lexicon: string;
}
interface VitsModelConfig {
    readonly model: string;
    readonly tokens: string;
    readonly dataDir: string;
}
export interface TtsConfig {
    readonly model: {
        readonly kokoro?: KokoroModelConfig;
        readonly vits?: VitsModelConfig;
        readonly numThreads: number;
        readonly provider: "cpu";
    };
    readonly maxNumSentences: number;
}
interface GenerationConfigInit {
    readonly sid: number;
    readonly speed: number;
    readonly extra: { readonly lang: string };
}
// An opaque handle the addon builds from GenerationConfigInit and reads back itself.
interface GenerationConfig {
    readonly sid: number;
}
type TtsRequest =
    | { readonly text: string; readonly sid: number; readonly speed: number }
    | { readonly text: string; readonly generationConfig: GenerationConfig };
interface OfflineTts {
    generateAsync(request: TtsRequest): Promise<Synthesized>;
}
interface Sherpa {
    readonly OfflineTts: new (config: TtsConfig) => OfflineTts;
    readonly GenerationConfig: new (config: GenerationConfigInit) => GenerationConfig;
}

// A Piper archive names its weights after the voice; read rather than assumed, since a few voices name it otherwise.
const onnxIn = (dir: string): string => {
    const found = readdirSync(dir).find((name) => name.endsWith(".onnx"));
    if (found === undefined) {
        throw new Error(`no .onnx model in ${dir}`);
    }
    return join(dir, found);
};

// sherpa-onnx's config for one spec. Kokoro reads English through its own lexicon and everything else through
// espeak-ng's phonemizer, told the language per request; Piper is a VITS model with espeak-ng's data beside it.
// `maxNumSentences: 1` is the daemon's own splitting repeated, so a sentence the splitter left long still streams.
export const ttsConfig = ({ kind, dir, threads }: SynthSpec): TtsConfig => ({
    model: {
        ...(kind === "kokoro"
            ? {
                  kokoro: {
                      model: join(dir, "model.onnx"),
                      voices: join(dir, "voices.bin"),
                      tokens: join(dir, "tokens.txt"),
                      dataDir: join(dir, "espeak-ng-data"),
                      lexicon: `${join(dir, "lexicon-us-en.txt")},${join(dir, "lexicon-zh.txt")}`,
                  },
              }
            : { vits: { model: onnxIn(dir), tokens: join(dir, "tokens.txt"), dataDir: join(dir, "espeak-ng-data") } }),
        numThreads: threads,
        provider: "cpu",
    },
    maxNumSentences: 1,
});

// Two models in memory at most (Kokoro and the one Piper voice in use, ~0.9 GB together); a third lets go of the one
// used longest ago.
const KEPT = 2;

export interface Synthesizers {
    readonly load: (spec: SynthSpec) => void;
    readonly say: (spec: SynthSpec, ask: SynthAsk) => Promise<Synthesized>;
}

export const createSynthesizers = (): Synthesizers => {
    // Loaded on first need: a sandbox that never speaks never maps the addon.
    let sherpa: Sherpa | undefined;
    const loaded = new Map<string, OfflineTts>();

    const ttsFor = (spec: SynthSpec): OfflineTts => {
        const held = loaded.get(spec.model);
        if (held !== undefined) {
            // Most recently used last, so the first one is the one to let go of.
            loaded.delete(spec.model);
            loaded.set(spec.model, held);
            return held;
        }
        // SAFETY: sherpa-onnx-node's exports are the classes this file types as Sherpa; the package ships no types.
        sherpa ??= createRequire(import.meta.url)("sherpa-onnx-node") as Sherpa;
        const tts = new sherpa.OfflineTts(ttsConfig(spec));
        loaded.set(spec.model, tts);
        while (loaded.size > KEPT) {
            const oldest = loaded.keys().next().value;
            if (oldest === undefined) {
                break;
            }
            loaded.delete(oldest);
        }
        return tts;
    };

    return {
        load: (spec) => void ttsFor(spec),
        say: async (spec, { text, sid, speed, lang }) => {
            const tts = ttsFor(spec);
            if (lang === undefined) {
                return tts.generateAsync({ text, sid, speed });
            }
            // SAFETY: ttsFor above has just loaded the addon into `sherpa`, or thrown.
            const config = new (sherpa as Sherpa).GenerationConfig({ sid, speed, extra: { lang } });
            return tts.generateAsync({ text, generationConfig: config });
        },
    };
};
