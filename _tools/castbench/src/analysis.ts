import type { DecoderLog, InputRecord, MarkerRecord } from "./client/decoder.js";
import { frameDelta, latencyMs } from "./marker.js";
import type { RunResult } from "./results.js";
import { gapsOf, mbpsOf, perSecond, round1, summarize, summarizeRate } from "./stats.js";

// What a run's raw events say, as numbers: the decoder page's log (what it decoded and when), the display probe's first
// sighting of each marker, and the measured window. Pure, so every number a run reports can be checked by value.

export interface MeasuredWindow {
    readonly from: number;
    readonly to: number;
}

export type Analysis = Pick<
    RunResult,
    | "picture"
    | "framesPerSec"
    | "uniqueFps"
    | "mbps"
    | "latencyMs"
    | "displayMs"
    | "pipelineMs"
    | "stalls"
    | "maxGapMs"
    | "keyMs"
    | "keyInputMs"
    | "pasteMs"
    | "inputMissed"
    | "markerErrors"
    | "decodeErrors"
    | "keyframes"
>;

const inside = (at: number, window: MeasuredWindow): boolean => at >= window.from && at <= window.to;

// The markers that showed a frame newer than any before them, each with when it was decoded: what a person sees move.
// A repeat of the same picture (a 30 fps capture of a page that did not change in between, a still being re-encoded) is
// not new.
export const newPictures = (markers: readonly MarkerRecord[]): MarkerRecord[] => {
    const fresh: MarkerRecord[] = [];
    let last: number | undefined;
    for (const marker of markers) {
        if (last === undefined || frameDelta(last, marker[0]) > 0) {
            fresh.push(marker);
            last = marker[0];
        }
    }
    return fresh;
};

// When the page received an input and drew its echo: the first decoded marker showing the length it expects, at or after
// it was sent. Its `ms` is the page's own clock at the input event.
const echoOf = (input: InputRecord, markers: readonly MarkerRecord[]): MarkerRecord | undefined =>
    markers.find((marker) => marker[0] === input.expect && marker[2] >= input.at);

// `firstSeen`: when the display probe first saw each marker value, undefined for a run without the probe.
export const analyze = (log: DecoderLog, window: MeasuredWindow, options: { readonly moving: boolean; readonly firstSeen: ReadonlyMap<number, number> | undefined }): Analysis => {
    const seconds = (window.to - window.from) / 1000;
    const fresh = newPictures(log.markers).filter((marker) => inside(marker[2], window));
    const freshTimes = fresh.map((marker) => marker[2]);
    const onDisplay = (frame: number, decodedAt: number): number | undefined => {
        const seen = options.firstSeen?.get(frame);
        // A sighting after the decode is of another lap of the 16-bit counter, never of this frame.
        return seen !== undefined && seen <= decodedAt ? seen : undefined;
    };
    const displayed = fresh.map((marker) => ({ marker, seen: onDisplay(marker[0], marker[2]) })).filter((entry) => entry.seen !== undefined);
    const gaps = options.moving ? gapsOf(freshTimes, window.from, window.to) : undefined;
    const inputs = log.inputs.filter((input) => inside(input.at, window));
    const answered = (kind: InputRecord["kind"]): number[] =>
        inputs.filter((input) => input.kind === kind && input.echoedAt !== null).map((input) => input.echoedAt! - input.at);
    return {
        picture: log.picture,
        framesPerSec: seconds > 0 ? round1(log.decoded.filter((at) => inside(at, window)).length / seconds) : null,
        uniqueFps: summarizeRate(perSecond(freshTimes, window.from, window.to)),
        mbps: mbpsOf(
            log.received.filter(([at]) => inside(at, window)).reduce((sum, [, bytes]) => sum + bytes, 0),
            window.to - window.from,
        ),
        latencyMs: summarize(fresh.map(([, ms, at]) => latencyMs(ms, at))),
        displayMs: summarize(displayed.map(({ marker, seen }) => latencyMs(marker[1], seen!))),
        pipelineMs: summarize(displayed.map(({ marker, seen }) => marker[2] - seen!)),
        stalls: gaps?.stalls ?? null,
        maxGapMs: gaps?.maxGapMs ?? null,
        keyMs: summarize(answered("key")),
        // Sent → the page's input event: how long the input path took before anything was drawn.
        keyInputMs: summarize(
            inputs
                .filter((input) => input.kind === "key")
                .flatMap((input) => {
                    const echo = echoOf(input, log.markers);
                    return echo === undefined ? [] : [-latencyMs(echo[1], input.at)];
                }),
        ),
        pasteMs: summarize(answered("paste")),
        inputMissed: inputs.filter((input) => input.echoedAt === null).length,
        markerErrors: log.markerErrors,
        decodeErrors: log.decodeErrors,
        keyframes: log.keyframes,
    };
};
