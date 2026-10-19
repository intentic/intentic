import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requires } from "@intentic/testing/requires";
import sharp from "sharp";
import { stateRelPath } from "../../../state-paths.js";
import { workspaceThumbnail } from "../workspace-thumbnail.js";
import { parseVideoFacts, videoFacts } from "./workspace-video.js";

/* A video's tile is a frame of it worth looking at. The case that started this: a film opening on a fade from white,
   whose first frame drew every tile as a blank card. Needs ffmpeg, which the browser pack brings. */

const ffmpeg = requires(existsSync("/usr/bin/ffmpeg") && existsSync("/usr/bin/ffprobe"), "ffmpeg and ffprobe", {
    absentOnCi: "no CI job that runs the daemon's suites installs the browser pack; the sandbox image carries it",
});

// Two seconds of white, then two of the test pattern: a third of the way in is still the fade, two thirds is not.
const writeFadeIn = (path: string, size: string): void => {
    execFileSync("ffmpeg", [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        `color=white:s=${size}:d=2:r=10`,
        "-f",
        "lavfi",
        "-i",
        `testsrc=s=${size}:d=2:r=10`,
        "-filter_complex",
        "[0:v][1:v]concat=n=2:v=1[v]",
        "-map",
        "[v]",
        "-pix_fmt",
        "yuv420p",
        path,
    ]);
};

const CACHE = stateRelPath(".intentic/local/cache/", "thumbnails");

const spreadOf = async (bytes: Buffer): Promise<number> => (await sharp(bytes).greyscale().stats()).channels[0]!.stdev;

describe.skipIf(!ffmpeg.runs)(ffmpeg.title("a video's tile"), () => {
    test("is a frame with something in it, past a white opening, in the video's own shape", async () => {
        const root = await mkdtemp(join(tmpdir(), "ws-video-"));
        const file = join(root, "fade-in.mp4");
        writeFadeIn(file, "640x360");

        const tile = await workspaceThumbnail(root, file, "tile");
        const drawn = await sharp(tile!.bytes).metadata();
        expect([tile!.type, drawn.width, drawn.height]).toEqual(["image/webp", 256, 144]);
        expect(await spreadOf(tile!.bytes)).toBeGreaterThan(16);
    });

    test("cuts its frame once, however many sizes it is drawn at", async () => {
        const root = await mkdtemp(join(tmpdir(), "ws-video-"));
        const file = join(root, "fade-in.mp4");
        writeFadeIn(file, "640x360");

        const tile = await workspaceThumbnail(root, file, "tile");
        const larger = await workspaceThumbnail(root, file, "e512");
        expect((await sharp(larger!.bytes).metadata()).width).toBe(512);
        expect(tile!.etag).not.toBe(larger!.etag);
        // Two renditions and the one frame they were both made from.
        const kept = await readdir(join(root, CACHE));
        expect(kept.filter((name) => name.endsWith(".png"))).toHaveLength(1);
        expect(kept.filter((name) => name.endsWith(".webp"))).toHaveLength(2);
    });

    test("reads a video's box and running time", async () => {
        const root = await mkdtemp(join(tmpdir(), "ws-video-"));
        const file = join(root, "portrait.mp4");
        writeFadeIn(file, "180x320");

        const facts = await videoFacts(file);
        expect([facts?.width, facts?.height]).toEqual([180, 320]);
        expect(facts?.duration).toBeCloseTo(4, 0);
        expect(await videoFacts(join(root, "absent.mp4"))).toBeUndefined();
    });
});

test("a phone's quarter-turn tag swaps the box it is shown in, and a stream with no size is no answer", () => {
    const stored = { streams: [{ width: 1920, height: 1080, side_data_list: [{ rotation: -90 }] }], format: { duration: "12.5" } };
    expect(parseVideoFacts(JSON.stringify(stored))).toEqual({ width: 1080, height: 1920, duration: 12.5 });
    const tagged = { streams: [{ width: 1920, height: 1080, tags: { rotate: "180" } }], format: {} };
    expect(parseVideoFacts(JSON.stringify(tagged))).toEqual({ width: 1920, height: 1080, duration: undefined });
    expect(parseVideoFacts(JSON.stringify({ streams: [{}] }))).toBeUndefined();
    expect(parseVideoFacts("not json")).toBeUndefined();
});
