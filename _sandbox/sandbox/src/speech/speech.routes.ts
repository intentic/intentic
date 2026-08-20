import { Hono } from "hono";
import type { Services } from "../composition.js";
import type { AppEnv } from "../context.js";
import { MAX_UTTERANCE_WAV_BYTES, SpeechModelNotReadyError, SpeechUnprovisionedError } from "./transcribe.js";

/* THE COMPOSER'S VOICE ROUTES, bytes in, words out, so they live beside the other byte routes rather than on
 * oRPC (the JSON contract has no business carrying a WAV). Both take the ordinary bearer like every data route.
 *
 * /speech/status is what the mic button asks BEFORE recording: whether this image carries whisper at all, and
 * whether the model is on disk yet. Asking is arming, an absent model starts downloading on the first status
 * call, so the browser's "Preparing voice" poll needs no separate trigger and no request is ever held open for
 * a ~1.6GB download.
 *
 * /speech/transcribe takes ONE utterance the browser already segmented and WAV-framed (16kHz mono s16le) and
 * answers its text, empty when whisper heard only silence/noise, which the composer treats as "nothing said"
 * rather than an error. The refusals that have a story get a status of their own: 501 when the image lacks
 * whisper-cli (say "rebuild", not "retry"), 409 while the model download is still running (say "wait"). */

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
