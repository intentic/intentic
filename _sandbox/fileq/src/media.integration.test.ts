import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requires } from "@intentic/testing/requires";
import { mediaDeriver } from "./lib/derivers/media.js";
import { onPath } from "./lib/tools.js";
import { wavBytes } from "./testing.js";

let root: string;
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "fileq-media-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("PCM format details survive the metadata parser upgrade", async () => {
    const path = join(root, "silence.wav");
    writeFileSync(path, wavBytes());
    const doc = await mediaDeriver.derive(path);
    expect(doc.markdown).toContain("Container: WAVE (PCM)");
    expect(doc.markdown).toContain("Sample rate: 8000 Hz, 1ch");
    expect(doc.markdown).toContain("Bitrate: 64 kbit/s");
});

test("compressed audio retains its duration and descriptive tags", async () => {
    requires(onPath("ffmpeg"), "ffmpeg encodes the real FLAC fixture");
    const source = join(root, "silence.wav");
    const path = join(root, "tagged.flac");
    writeFileSync(source, wavBytes());
    execFileSync("ffmpeg", [
        "-v",
        "error",
        "-i",
        source,
        "-threads",
        "1",
        "-metadata",
        "title=Fixture audio",
        "-metadata",
        "artist=Fixture artist",
        path,
    ]);
    const doc = await mediaDeriver.derive(path);
    expect(doc.title).toBe("Fixture audio");
    expect(doc.markdown).toContain("Duration: 1s");
    expect(doc.markdown).toContain("Artist: Fixture artist");
});

test("a video container retains its duration and title", async () => {
    requires(onPath("ffmpeg"), "ffmpeg encodes the real MP4 fixture");
    const path = join(root, "tagged.mp4");
    execFileSync("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=16x16:r=1",
        "-t",
        "1",
        "-c:v",
        "mpeg4",
        "-threads",
        "1",
        "-metadata",
        "title=Fixture video",
        path,
    ]);
    const doc = await mediaDeriver.derive(path);
    expect(doc.title).toBe("Fixture video");
    expect(doc.markdown).toContain("Duration: 1s");
});

test("a truncated WAVE identifies the container without inventing a duration", async () => {
    const path = join(root, "truncated.wav");
    writeFileSync(path, wavBytes().subarray(0, 20));
    const doc = await mediaDeriver.derive(path);
    expect(doc.markdown).toBe("- Container: WAVE");
});

test("an audio extension alone does not produce fabricated metadata", async () => {
    const path = join(root, "unrecognized.wav");
    writeFileSync(path, "this is not an audio container");
    const doc = await mediaDeriver.derive(path);
    expect(doc.markdown).toBe("");
    expect(doc.title).toBe(undefined);
});
