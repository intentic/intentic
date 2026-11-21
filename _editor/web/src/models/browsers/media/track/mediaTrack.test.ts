// The pictures on a video track, on a fake `<video>`: shown only while castd's hello says the track carries them, the
// first picture shown said once per hello, its size kept, and the overlay's numbers read off the browser's report.
import { unstubbed } from "@intentic/testing";
import { mediaTrack, type VideoLike } from "./mediaTrack";

class FakeVideo implements VideoLike {
    srcObject: MediaProvider | null = null;
    plays = 0;
    readonly callbacks = new Map<number, VideoFrameRequestCallback>();
    private next = 0;
    async play(): Promise<void> {
        this.plays += 1;
    }
    requestVideoFrameCallback(callback: VideoFrameRequestCallback): number {
        this.next += 1;
        this.callbacks.set(this.next, callback);
        return this.next;
    }
    cancelVideoFrameCallback(handle: number): void {
        this.callbacks.delete(handle);
    }
    // The browser shows a picture: every callback waiting runs, once.
    present(meta: Partial<VideoFrameCallbackMetadata>, now = 1000): void {
        const waiting = [...this.callbacks.values()];
        this.callbacks.clear();
        for (const callback of waiting) {
            callback(now, { expectedDisplayTime: now, height: 720, mediaTime: 0, presentationTime: now, presentedFrames: 1, width: 1280, ...meta });
        }
    }
}

const STREAM = unstubbed<MediaProvider>(`stream`, {});
const TRACK = unstubbed<MediaStreamTrack>(`track`, { kind: `video` });

const setup = (report: () => Promise<RTCStatsReport | undefined> = async () => undefined) => {
    let shown = 0;
    const track = mediaTrack({ shown: () => (shown += 1), report, stream: () => STREAM });
    const video = new FakeVideo();
    track.attach(video);
    return { track, video, shown: () => shown };
};

it("shows the track only once the hello says it carries the pictures, and says its first picture once", () => {
    const { track, video, shown } = setup();
    track.took(TRACK);
    // The track is there from the offer, but castd has not moved the pictures onto it.
    expect([track.live.value, video.srcObject, video.plays]).toEqual([false, null, 0]);
    track.carrying(true);
    expect([track.live.value, video.srcObject, video.plays]).toEqual([true, STREAM, 1]);
    video.present({ width: 1920, height: 1080 });
    video.present({ width: 1920, height: 1080 });
    expect([shown(), track.size.value]).toEqual([1, { width: 1920, height: 1080 }]);
    // A hello on the socket: the pictures are the canvas's again.
    track.carrying(false);
    expect([track.live.value, video.srcObject]).toEqual([false, null]);
    // The next hello that moves them back says its first picture again.
    track.carrying(true);
    video.present({});
    expect(shown()).toBe(2);
    // The peer going takes the track.
    track.took(undefined);
    expect([track.live.value, video.srcObject]).toEqual([false, null]);
});

it("hands a `<video>` attached late what is showing, and lets go of one detached", () => {
    const { track, video } = setup();
    track.took(TRACK);
    track.carrying(true);
    const late = new FakeVideo();
    track.attach(late);
    expect([late.srcObject, late.callbacks.size]).toEqual([STREAM, 1]);
    track.attach(null);
    late.present({});
    expect(video.callbacks.size).toBe(0);
});

it("reads the overlay's numbers off the browser's report between two reads, with castd's word beside them", async () => {
    const reports: Record<string, unknown>[][] = [
        [
            { type: `inbound-rtp`, kind: `video`, framesDecoded: 100, framesDropped: 1, totalDecodeTime: 0.2, bytesReceived: 1_000_000, frameWidth: 1280, frameHeight: 720 },
            { type: `candidate-pair`, nominated: true, currentRoundTripTime: 0.05 },
        ],
        [
            { type: `inbound-rtp`, kind: `video`, framesDecoded: 130, framesDropped: 2, totalDecodeTime: 0.26, bytesReceived: 1_250_000, frameWidth: 1280, frameHeight: 720 },
            { type: `inbound-rtp`, kind: `audio`, framesDecoded: 9 },
        ],
    ];
    let read = 0;
    const report = async (): Promise<RTCStatsReport> => {
        const entries = reports[read] ?? [];
        read += 1;
        const made: RTCStatsReport = unstubbed<RTCStatsReport>(`report`, {
            forEach: (each) => entries.forEach((entry, index) => each(entry, String(index), made)),
        });
        return made;
    };
    const { track, video } = setup(report);
    // Nothing on the track yet: nothing to read.
    expect(await track.stats({ scale: 1 })).toBeUndefined();
    track.took(TRACK);
    track.carrying(true);
    video.present({ captureTime: 940 }, 1000);
    const first = await track.stats({ scale: 2, targetKbps: 4000 });
    expect(first).toMatchObject({ fps: 0, kbps: 0, rttMs: 50, width: 1280, height: 720, dropped: 1, stripes: 1, scale: 2, targetKbps: 4000, ageMs: 60 });
    const second = await track.stats({ scale: 2 });
    // 30 frames and 250 kB since the first read; decoding took 2 ms a frame.
    expect(second?.dropped).toBe(2);
    expect(second?.decodeMs).toBeCloseTo(2, 5);
    expect(second?.rttMs).toBeUndefined();
});
