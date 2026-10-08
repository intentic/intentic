import { STILL_DELAY_MS, STILL_IDLE_MS } from "./screencast.js";

// A sharp still of the page whenever it settles, over the video path: video is right while something moves and soft
// while someone reads, so once the encoder has gone quiet a grab of the display's own pixels (videocast.ts's grabStill)
// replaces the picture, and the frames that follow are marked quiet so the client keeps the still until something really
// moves. Same settle rules as the frames path (screencast.ts), read off the encoder's output instead of the compositor's
// frames.
//
// Size says motion, and it misses the small answers: a typed character, a ticked box, a button lit by the pointer. So a
// click or a keystroke withdraws the still outright (noteAction), the pointer coming to rest asks for another look
// (noteInput), and a still that found something new is followed by one more look, which is how a page that keeps
// changing a little (a caret, a countdown) keeps showing it.
//
// The grab reads the display and changes nothing on it. The page photograph it replaced re-rendered the live window,
// which the video filmed as motion, so a window after every capture had to be taken for its echo; there is none now,
// and a loud frame is always the page moving.

// A delta frame of a still page costs x264 a few hundred bytes; anything moving costs kilobytes. Keyframes are never
// motion: one arrives every second whatever the page does.
export const QUIET_BYTES = 3000;

export interface EncodedFrame {
    readonly key: boolean;
    readonly bytes: number;
}

export const isLoud = (frame: EncodedFrame): boolean => !frame.key && frame.bytes > QUIET_BYTES;

export interface StillTakerOptions {
    // The WebP of the picture's rectangle as the display shows it, base64; undefined when it could not be grabbed.
    readonly capture: () => Promise<string | undefined>;
    readonly send: (still: Buffer) => void;
}

export interface StillTaker {
    // Tells the caller how to tag this frame: `quiet` while a still stands for the page, `paint` otherwise.
    readonly noteFrame: (frame: EncodedFrame) => "paint" | "quiet";
    // The owner moved the pointer: what it hovers may have lit up below what reads as motion, so the page is looked at
    // again once the pointer rests. The still stands meanwhile; withdrawing it on every move would blur the text the
    // pointer passes over.
    readonly noteInput: () => void;
    // A click or a keystroke: its answer may be too small to read as motion, so the still no longer stands for the
    // page. Frames paint until the page settles and a fresh still is taken.
    readonly noteAction: () => void;
    // A new page or a new region: the still shown says nothing about it, and a fresh one is owed once it settles.
    readonly reset: () => void;
    readonly setPaused: (paused: boolean) => void;
    readonly stop: () => void;
}

export const createStillTaker = (options: StillTakerOptions): StillTaker => {
    let stopped = false;
    let paused = false;
    // A still the client is holding, with nothing having moved since; what makes the frames after it quiet.
    let shown = false;
    let lastStill: string | undefined;
    // Consecutive looks that found nothing new; exponent of the back-off between them.
    let quiet = 0;
    let timer: NodeJS.Timeout | undefined;
    // Bumped by whatever makes a grab already under way describe a picture that is gone: motion, another tab or region
    // (reset), a click or a keystroke (noteAction), a pause. Such a grab lands after the fact, and sent, it stood over the
    // live picture as the old tab, held there by every quiet frame after it, until something moved (2026-10-08).
    let generation = 0;

    const take = async (): Promise<void> => {
        if (stopped || paused) {
            return;
        }
        const asked = generation;
        const data = await options.capture().catch(() => undefined);
        if (data === undefined || stopped || paused || asked !== generation) {
            return;
        }
        if (data === lastStill) {
            // Pixel-identical to what the client holds: nothing to send, and the next look waits longer.
            quiet += 1;
            return;
        }
        lastStill = data;
        quiet = 0;
        shown = true;
        options.send(Buffer.from(data, "base64"));
        // The page changed since the last look and may still be changing below what reads as motion; one more look
        // says, and an identical one ends it.
        arm();
    };

    const arm = (): void => {
        if (stopped || paused) {
            return;
        }
        clearTimeout(timer);
        timer = setTimeout(() => void take(), Math.min(STILL_DELAY_MS * 2 ** quiet, STILL_IDLE_MS));
    };

    // The still no longer stands for the page: frames paint, and a fresh one follows the settle.
    const withdraw = (): void => {
        generation += 1;
        shown = false;
        lastStill = undefined;
        quiet = 0;
        arm();
    };

    return {
        noteFrame: (frame) => {
            if (!isLoud(frame)) {
                return shown ? "quiet" : "paint";
            }
            withdraw();
            return "paint";
        },
        noteInput: () => {
            quiet = 0;
            arm();
        },
        noteAction: withdraw,
        reset: withdraw,
        setPaused: (next) => {
            paused = next;
            generation += 1;
            if (next) {
                clearTimeout(timer);
                return;
            }
            shown = false;
            lastStill = undefined;
            quiet = 0;
            arm();
        },
        stop: () => {
            stopped = true;
            clearTimeout(timer);
        },
    };
};
