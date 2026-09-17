import { CAPTURE_ECHO_FACTOR, CAPTURE_ECHO_MS, STILL_DELAY_MS, STILL_IDLE_MS } from "./screencast.js";

// A sharp still of the page whenever it settles, over the video path: 4:2:0 video is right while something moves and
// wrong while someone reads, so once the encoder has gone quiet a 2× capture replaces the picture, and the frames that
// follow are marked quiet so the client keeps the still until something really moves. Same settle rules as the frames
// path (screencast.ts), read off the encoder's output instead of the compositor's frames.

// A delta frame of a still page costs x264 a few hundred bytes; anything moving costs kilobytes. Keyframes are never
// motion: one arrives every second whatever the page does.
export const QUIET_BYTES = 3000;

export interface EncodedFrame {
    readonly key: boolean;
    readonly bytes: number;
}

export const isLoud = (frame: EncodedFrame): boolean => !frame.key && frame.bytes > QUIET_BYTES;

export interface StillTakerOptions {
    // The 2× WebP of the viewport, base64 as CDP hands it back; undefined when the page could not be photographed.
    readonly capture: () => Promise<string | undefined>;
    readonly send: (still: Buffer) => void;
    readonly now?: () => number;
}

export interface StillTaker {
    // Tells the caller how to tag this frame: `quiet` while a still stands for the page, `paint` otherwise.
    readonly noteFrame: (frame: EncodedFrame) => "paint" | "quiet";
    // The owner acted; the next frames are a response, not a capture's own echo.
    readonly noteInput: () => void;
    // A new page or a new region: the still shown says nothing about it, and a fresh one is owed once it settles.
    readonly reset: () => void;
    readonly setPaused: (paused: boolean) => void;
    readonly stop: () => void;
}

export const createStillTaker = (options: StillTakerOptions): StillTaker => {
    const now = options.now ?? Date.now;
    let stopped = false;
    let paused = false;
    // A still the client is holding, with nothing having moved since; what makes the frames after it quiet.
    let shown = false;
    let lastStill: string | undefined;
    // Consecutive captures that found nothing new; exponent of the back-off between them.
    let quiet = 0;
    let capturing = false;
    let echoUntil = 0;
    let captureStartedAt = 0;
    let lastInputAt = 0;
    let timer: NodeJS.Timeout | undefined;

    const take = async (): Promise<void> => {
        if (stopped || paused) {
            return;
        }
        capturing = true;
        const startedAt = now();
        captureStartedAt = startedAt;
        const data = await options.capture().catch(() => undefined);
        capturing = false;
        // The capture re-rasters the page, which the grab sees; frames inside this window are its echo, for a duration
        // scaled by what the capture cost.
        echoUntil = now() + Math.min(Math.max(CAPTURE_ECHO_MS, (now() - startedAt) * CAPTURE_ECHO_FACTOR), STILL_IDLE_MS);
        if (data === undefined || stopped || paused) {
            return;
        }
        if (data === lastStill) {
            // Pixel-identical to what the client holds: the frames since were echoes, nothing to send.
            quiet += 1;
            return;
        }
        lastStill = data;
        quiet = 0;
        shown = true;
        options.send(Buffer.from(data, "base64"));
    };

    const arm = (): void => {
        clearTimeout(timer);
        timer = setTimeout(() => void take(), Math.min(STILL_DELAY_MS * 2 ** quiet, STILL_IDLE_MS));
    };

    return {
        noteFrame: (frame) => {
            if (!isLoud(frame)) {
                return shown ? "quiet" : "paint";
            }
            const echo = (capturing || now() < echoUntil) && lastInputAt < captureStartedAt;
            if (echo) {
                // Re-armed only while the last capture found something new: once one came back identical, a further
                // capture would only echo again, and only real motion re-opens the question.
                if (quiet === 0) {
                    arm();
                }
                return shown ? "quiet" : "paint";
            }
            shown = false;
            lastStill = undefined;
            quiet = 0;
            arm();
            return "paint";
        },
        noteInput: () => {
            lastInputAt = now();
        },
        reset: () => {
            shown = false;
            lastStill = undefined;
            quiet = 0;
            echoUntil = 0;
            if (!paused && !stopped) {
                arm();
            }
        },
        setPaused: (next) => {
            paused = next;
            if (next) {
                clearTimeout(timer);
                return;
            }
            shown = false;
            lastStill = undefined;
            quiet = 0;
            echoUntil = 0;
            arm();
        },
        stop: () => {
            stopped = true;
            clearTimeout(timer);
        },
    };
};
