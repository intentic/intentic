import { ref, type Ref, shallowRef } from "vue";
import { z } from "zod";
import type { MediaStats } from "../frameBook";

// THE PICTURES ON A VIDEO TRACK (mediaRtc.ts asks for one where the view can show it). Once castd's hello on the peer
// says the pictures ride the track (`track`), the view shows them in a `<video>` it hands over (`attach`) instead of the
// decode worker's canvas: the browser's own WebRTC pipeline decodes them, its jitter buffer told to hold nothing. Nothing
// is acked: castd's bitrate and pace follow the track's congestion control (cast-core's README). The stats overlay reads
// the browser's own numbers (getStats).

/** The `<video>` showing the track, as far as this uses one. */
export interface VideoLike {
    srcObject: MediaProvider | null;
    play(): Promise<void>;
    requestVideoFrameCallback(callback: VideoFrameRequestCallback): number;
    cancelVideoFrameCallback(handle: number): void;
}

export interface MediaTrackOptions {
    // The first picture since the hello was shown.
    readonly shown: () => void;
    // The connection's numbers, where there is a connection.
    readonly report: () => Promise<RTCStatsReport | undefined>;
    // Seam for a test: the stream a `<video>` shows a track in.
    readonly stream?: (track: MediaStreamTrack) => MediaProvider;
}

export interface MediaTrack {
    // The pictures ride the track now, and the view shows its `<video>`.
    readonly live: Ref<boolean>;
    // The size of the last picture shown, in its own pixels.
    readonly size: Ref<{ readonly width: number; readonly height: number } | undefined>;
    // The peer handed a track (or let it go).
    readonly took: (track: MediaStreamTrack | undefined) => void;
    // castd's latest hello said whether the pictures ride the track.
    readonly carrying: (on: boolean) => void;
    readonly attach: (video: VideoLike | null) => void;
    // The overlay's numbers from the browser's own, with castd's word added; undefined while the track carries nothing.
    readonly stats: (castd: Pick<MediaStats, `targetKbps` | `queueMs` | `sentFps` | `scale`>) => Promise<MediaStats | undefined>;
}

// The fields of the browser's `inbound-rtp` video report the overlay reads, and the round trip off the pair in use, read
// at the boundary: a field this browser does not report counts as zero.
const counter = z.number().catch(0);
const InboundSchema = z.object({
    type: z.literal(`inbound-rtp`),
    kind: z.literal(`video`),
    framesDecoded: counter,
    framesDropped: counter,
    totalDecodeTime: counter,
    bytesReceived: counter,
    frameWidth: counter,
    frameHeight: counter,
});
const PairSchema = z.object({ type: z.literal(`candidate-pair`), nominated: z.literal(true), currentRoundTripTime: z.number() });

interface Inbound extends Omit<z.infer<typeof InboundSchema>, `type` | `kind`> {
    readonly at: number;
    readonly rttMs: number | undefined;
}

const inbound = (report: RTCStatsReport, at: number): Inbound | undefined => {
    let video: z.infer<typeof InboundSchema> | undefined;
    let rttMs: number | undefined;
    report.forEach((entry) => {
        const read = InboundSchema.safeParse(entry);
        const pair = PairSchema.safeParse(entry);
        if (read.success) {
            video = read.data;
        } else if (pair.success) {
            rttMs = pair.data.currentRoundTripTime * 1000;
        }
    });
    return video === undefined ? undefined : { ...video, at, rttMs };
};

// How old each picture was when shown (capture to the frame it was composited in), the last two seconds of them.
const AGE_WINDOW_MS = 2000;
const percentile = (values: readonly number[], share: number): number | undefined => {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted.length === 0 ? undefined : sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))];
};

// The overlay's numbers between two reports of the browser's.
const between = (before: Inbound | undefined, now: Inbound, ages: readonly number[]): Omit<MediaStats, `targetKbps` | `queueMs` | `sentFps` | `scale`> => {
    const seconds = before === undefined ? 0 : (now.at - before.at) / 1000;
    const frames = before === undefined ? 0 : now.framesDecoded - before.framesDecoded;
    return {
        fps: seconds > 0 ? Math.round(frames / seconds) : 0,
        decodeMs: frames > 0 && before !== undefined ? ((now.totalDecodeTime - before.totalDecodeTime) * 1000) / frames : undefined,
        ageMs: percentile(ages, 0.5),
        ageP95Ms: percentile(ages, 0.95),
        rttMs: now.rttMs,
        kbps: seconds > 0 && before !== undefined ? ((now.bytesReceived - before.bytesReceived) * 8) / 1000 / seconds : 0,
        dropped: now.framesDropped,
        width: now.frameWidth,
        height: now.frameHeight,
        stripes: 1,
    };
};

const browserStream = (track: MediaStreamTrack): MediaProvider => new MediaStream([track]);

export const mediaTrack = (options: MediaTrackOptions): MediaTrack => {
    const live = ref(false);
    const size = shallowRef<{ readonly width: number; readonly height: number } | undefined>();
    let track: MediaStreamTrack | undefined;
    let carried = false;
    let video: VideoLike | undefined;
    let callback: number | undefined;
    let pictured = false;
    let last: Inbound | undefined;
    let ages: { readonly at: number; readonly ms: number }[] = [];

    const onFrame = (now: number, meta: VideoFrameCallbackMetadata): void => {
        callback = video?.requestVideoFrameCallback(onFrame);
        if (!live.value) {
            return;
        }
        if (meta.captureTime !== undefined) {
            ages = [...ages.filter((age) => age.at > now - AGE_WINDOW_MS), { at: now, ms: now - meta.captureTime }];
        }
        if (size.value?.width !== meta.width || size.value.height !== meta.height) {
            size.value = { width: meta.width, height: meta.height };
        }
        if (!pictured) {
            pictured = true;
            options.shown();
        }
    };

    // The `<video>` shows the track while it carries the pictures, and nothing otherwise.
    const show = (): void => {
        live.value = carried && track !== undefined;
        if (video === undefined) {
            return;
        }
        if (callback !== undefined) {
            video.cancelVideoFrameCallback(callback);
            callback = undefined;
        }
        if (!live.value || track === undefined) {
            video.srcObject = null;
            return;
        }
        video.srcObject = (options.stream ?? browserStream)(track);
        // allow(silent-catch): a `<video>` that will not play yet (no gesture on a page that wants one) shows nothing, and the next hello tries again.
        void video.play().catch(() => undefined);
        callback = video.requestVideoFrameCallback(onFrame);
    };

    return {
        live,
        size,
        took: (next) => {
            track = next;
            show();
        },
        carrying: (on) => {
            carried = on;
            pictured = false;
            ages = [];
            show();
        },
        attach: (next) => {
            if (video !== undefined && callback !== undefined) {
                video.cancelVideoFrameCallback(callback);
                callback = undefined;
            }
            video = next ?? undefined;
            show();
        },
        stats: async (castd) => {
            const report = live.value ? await options.report() : undefined;
            const now = report === undefined ? undefined : inbound(report, performance.now());
            if (now === undefined) {
                return undefined;
            }
            // A window behind another, or a tab in the background, gets no video frame callbacks: the browser decodes the
            // track but composites nothing. The decoder's own count says a picture is there, so the view stops saying
            // it is connecting instead of waiting for a callback that comes only once the window is in front.
            if (!pictured && now.framesDecoded > 0) {
                pictured = true;
                options.shown();
            }
            const stats = { ...between(last, now, ages.map((age) => age.ms)), ...castd };
            last = now;
            return stats;
        },
    };
};
