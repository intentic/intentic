import { Hono } from "hono";
import type { Services } from "../composition.js";
import type { AppEnv } from "../app-env.js";
import { MAX_UTTERANCE_WAV_BYTES, SpeechModelNotReadyError, SpeechUnprovisionedError } from "./transcribe.js";

// Bytes in, words out, off oRPC since a WAV doesn't fit its JSON contract. `/speech/status` is arming: an absent model
// starts downloading on the first call. `/speech/transcribe` takes one pre-segmented WAV utterance (16kHz mono s16le);
// empty text means silence, not an error. 501 means no whisper-cli (rebuild); 409 means the model is still downloading
// (wait).

export type SpeechRoutesDeps = Pick<Services, "perf" | "speech">;

export const createSpeechRoute = (services: SpeechRoutesDeps): Hono<AppEnv> => {
    const app = new Hono<AppEnv>();

    app.get("/speech/status", async (c) => c.json(await services.speech.status()));

    app.post("/speech/transcribe", async (c) => {
        const declared = Number(c.req.header("content-length"));
        if (Number.isFinite(declared) && declared > MAX_UTTERANCE_WAV_BYTES) {
            return c.json({ error: "utterance too long" }, 413);
        }
        const wav = Buffer.from(await c.req.arrayBuffer());
        if (wav.byteLength > MAX_UTTERANCE_WAV_BYTES) {
            return c.json({ error: "utterance too long" }, 413);
        }
        if (wav.byteLength === 0) {
            return c.json({ error: "empty audio" }, 400);
        }
        try {
            const text = await services.perf.track("speech.transcribe", { bytes: wav.byteLength }, () =>
                services.speech.transcribe(wav, c.req.query("lang")),
            );
            return c.json({ text });
        } catch (error) {
            if (error instanceof SpeechUnprovisionedError) {
                return c.json({ error: error.message }, 501);
            }
            if (error instanceof SpeechModelNotReadyError) {
                return c.json({ error: error.message }, 409);
            }
            throw error;
        }
    });

    return app;
};
