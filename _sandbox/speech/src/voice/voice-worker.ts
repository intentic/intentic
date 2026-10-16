import { errorMessage } from "@intentic/base/errors";
import { createSynthesizers, type SynthAsk, type SynthSpec } from "./voice-synth.js";

// The voice process: forked by voice-process.ts, it holds the voice models in memory and speaks one sentence at a time,
// answered over IPC with structured-clone serialization so a sentence's samples cross as a Float32Array rather than JSON.

export type VoiceWorkerAsk =
    | { readonly id: number; readonly kind: "load"; readonly spec: SynthSpec }
    | { readonly id: number; readonly kind: "say"; readonly spec: SynthSpec; readonly ask: SynthAsk };

export type VoiceWorkerAnswer =
    | { readonly id: number; readonly ok: true; readonly samples?: Float32Array; readonly sampleRate?: number }
    | { readonly id: number; readonly ok: false; readonly message: string };

const synthesizers = createSynthesizers();

const answer = async (ask: VoiceWorkerAsk): Promise<VoiceWorkerAnswer> => {
    try {
        if (ask.kind === "load") {
            synthesizers.load(ask.spec);
            return { id: ask.id, ok: true };
        }
        const { samples, sampleRate } = await synthesizers.say(ask.spec, ask.ask);
        return { id: ask.id, ok: true, samples, sampleRate };
    } catch (error) {
        return { id: ask.id, ok: false, message: errorMessage(error) };
    }
};

process.on("message", (ask: VoiceWorkerAsk) => {
    void answer(ask).then((reply) => process.send?.(reply));
});

// The daemon going away takes this process with it, rather than leaving its models' memory behind.
process.on("disconnect", () => process.exit(0));
