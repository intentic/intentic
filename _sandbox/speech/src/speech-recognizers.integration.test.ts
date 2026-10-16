import { existsSync } from "node:fs";
import { join } from "node:path";
import { requires } from "@intentic/testing/requires";
import { createSpeechProcess } from "./speech-engine.js";
import { BAKED_SPEECH_MODELS_DIR, SPEECH_MODELS } from "./speech-models.js";

/* The real model, in the real speech process: a phrase of synthetic silence is heard as no words, and the model loads
   from the layout the image bakes. Runs where Parakeet is on disk (the standard image, or SPEECH_MODELS_DIR pointing at
   a directory laid out the same way); speech is the one thing no fake can say it hears. */

const modelsDir = process.env["SPEECH_MODELS_DIR"] ?? BAKED_SPEECH_MODELS_DIR;
const parakeet = join(modelsDir, "parakeet");
const present = requires(
    SPEECH_MODELS.parakeet.files.every((file) => existsSync(join(parakeet, file.path))),
    "the Parakeet model the standard image bakes at /opt/speech-models",
    { absentOnCi: "the daemon's suites run outside the image, where the model is not baked" },
);

describe.skipIf(!present.runs)(present.title("Parakeet in the speech process"), () => {
    test("loads, hears silence as no words, and lets go of its memory on close", async () => {
        const speech = createSpeechProcess({ log: () => {} });
        try {
            const spec = { engine: "parakeet" as const, dir: parakeet, threads: 2 };
            await speech.load(spec);
            expect(speech.loaded("parakeet")).toBe(true);
            expect((await speech.decode(spec, new Float32Array(16_000 * 2))).trim()).toBe("");
        } finally {
            speech.close();
        }
        expect(speech.loaded("parakeet")).toBe(false);
    }, 60_000);
});
