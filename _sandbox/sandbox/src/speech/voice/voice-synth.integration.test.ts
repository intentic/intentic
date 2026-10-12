import { existsSync } from "node:fs";
import { join } from "node:path";
import { requires } from "@intentic/testing/requires";
import { localDefault } from "./voice-models.js";
import { createVoiceProcess } from "./voice-process.js";

/* The real models, in the real voice process: Kokoro and a Piper voice each say a sentence as a second or more of
   audio at their own rate. Runs where the models are on disk (VOICE_MODELS_DIR pointing at a directory holding each
   model's unpacked archive under its own name, as the workspace cache keeps them); speech is the one thing no fake can
   say it makes. */

const modelsDir = process.env["VOICE_MODELS_DIR"] ?? "";
const kokoro = localDefault("en");
const piper = localDefault("pl");
const present = requires(
    modelsDir !== "" && existsSync(join(modelsDir, kokoro.model.id, "model.onnx")) && existsSync(join(modelsDir, piper.model.id, "tokens.txt")),
    "Kokoro and the Polish Piper voice unpacked under VOICE_MODELS_DIR",
    { absentOnCi: "the voice models are fetched on first use, never baked, so CI has none" },
);

describe.skipIf(!present.runs)(present.title("Kokoro and Piper in the voice process"), () => {
    test("each says a sentence, and the process lets go of its models on close", async () => {
        const voice = createVoiceProcess({ log: () => {} });
        try {
            for (const [chosen, text] of [
                [kokoro, "The login form now rejects an empty password."],
                [piper, "Formularz logowania odrzuca teraz puste hasło."],
            ] as const) {
                const spec = { kind: chosen.model.kind, model: chosen.model.id, dir: join(modelsDir, chosen.model.id), threads: 2 };
                const audio = await voice.say(spec, { text, sid: chosen.sid, speed: 1 });
                expect(audio.sampleRate).toBe(chosen.model.kind === "kokoro" ? 24_000 : 22_050);
                expect(audio.samples.length / audio.sampleRate).toBeGreaterThan(1);
                expect(Math.max(...audio.samples.slice(0, 48_000).map(Math.abs))).toBeGreaterThan(0.05);
            }
            expect(voice.loaded(kokoro.model.id)).toBe(true);
        } finally {
            voice.close();
        }
        expect(voice.loaded(kokoro.model.id)).toBe(false);
    }, 120_000);
});
