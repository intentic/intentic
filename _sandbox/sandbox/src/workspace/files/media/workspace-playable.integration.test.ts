import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requires } from "@intentic/testing/requires";
import { createApp } from "../../../app.js";
import { services } from "../../../harness/route-services.testing.js";
import { workspacePaths } from "../../workspace.js";
import { fakeFiles } from "../../workspace-slice.testing.js";
import { statWorkspaceFileSize } from "../workspace-files.js";
import { playableMedia, type Playable } from "./workspace-playable.js";

/* A recording or video the browser can't decode plays anyway: the case that started this was a folder of WAVs, and the
   ones a browser refuses are the ADPCM and 64-bit-float kinds, AIFF, CAF, WMA and AMR; for video, AVI, WMV, FLV, MPEG
   and pictures in HEVC, 10-bit or 4:4:4. Needs ffmpeg, which the browser pack brings. */

const ffmpeg = requires(existsSync("/usr/bin/ffmpeg") && existsSync("/usr/bin/ffprobe"), "ffmpeg and ffprobe", {
    absentOnCi: "no CI job that runs the daemon's suites installs the browser pack; the sandbox image carries it",
});

// One second of a tone in `codec`, the encoding no browser decodes inside a WAV.
const writeTone = (path: string, codec: string): void => {
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", codec, path]);
};

// Two seconds of a test card `size` big with a tone under it, the picture made by `picture` (an encoder and its settings),
// boxed by the name's extension.
const writeClip = (path: string, size: string, picture: readonly string[]): void => {
    execFileSync("ffmpeg", [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        `testsrc=size=${size}:rate=10:duration=2`,
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=2",
        ...picture,
        "-c:a",
        "mp3",
        path,
    ]);
};

const probe = (path: string, stream: string, entries: string): string =>
    execFileSync("ffprobe", ["-v", "error", "-select_streams", stream, "-show_entries", `stream=${entries}`, "-of", "csv=p=0", path])
        .toString()
        .trim();
const codecOf = (path: string): string => probe(path, "a:0", "codec_name");

// A rendition that was ready within the wait; the tests' files are seconds long, so anything else is a failure.
const made = (answer: Playable | "rendering" | undefined): Playable => {
    if (answer === undefined || answer === "rendering") {
        throw new Error(`expected a rendition, got ${String(answer)}`);
    }
    return answer;
};

describe.skipIf(!ffmpeg.runs)(ffmpeg.title("a recording or video the browser can't decode"), () => {
    test("is rendered once as AAC, and the same rendition is handed back until the file changes", async () => {
        const root = await mkdtemp(join(tmpdir(), "ws-playable-"));
        try {
            const take = join(root, "take.wav");
            writeTone(take, "adpcm_ima_wav");
            const first = made(await playableMedia(root, take));
            expect(first.path).toMatch(/\.m4a$/);
            expect(first.type).toBe("audio/mp4");
            expect(codecOf(first.path)).toBe("aac");
            expect(made(await playableMedia(root, take)).path).toBe(first.path);

            writeTone(take, "pcm_f64le");
            const changed = made(await playableMedia(root, take));
            expect(changed.path).not.toBe(first.path);
            expect(codecOf(changed.path)).toBe("aac");
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("has none where it is no recording or ffmpeg can't read it", async () => {
        const root = await mkdtemp(join(tmpdir(), "ws-playable-"));
        try {
            await writeFile(join(root, "notes.md"), "# notes");
            await writeFile(join(root, "broken.wav"), "not a recording");
            await writeFile(join(root, "broken.avi"), "not a video");
            expect(await playableMedia(root, join(root, "notes.md"))).toBeUndefined();
            expect(await playableMedia(root, join(root, "broken.wav"))).toBeUndefined();
            expect(await playableMedia(root, join(root, "broken.avi"))).toBeUndefined();
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("a video is re-encoded to H.264 in 8-bit 4:2:0 with AAC, its sides even, when its picture won't decode", async () => {
        const root = await mkdtemp(join(tmpdir(), "ws-playable-"));
        try {
            // 4:4:4 H.264 (what an encoder fed RGB frames writes by default) is refused by Chrome and Firefox alike.
            const clip = join(root, "clip.mkv");
            writeClip(clip, "321x241", ["-c:v", "libx264", "-pix_fmt", "yuv444p"]);
            const rendition = made(await playableMedia(root, clip));
            expect(rendition.path).toMatch(/\.mp4$/);
            expect(rendition.type).toBe("video/mp4");
            expect(probe(rendition.path, "v:0", "codec_name,pix_fmt,width,height")).toBe("h264,320,240,yuv420p");
            expect(codecOf(rendition.path)).toBe("aac");
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("a video whose picture already decodes is only moved into an MP4, not re-encoded", async () => {
        const root = await mkdtemp(join(tmpdir(), "ws-playable-"));
        try {
            const clip = join(root, "clip.avi");
            writeClip(clip, "320x240", ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "40"]);
            const rendition = made(await playableMedia(root, clip));
            expect(probe(rendition.path, "v:0", "codec_name,pix_fmt")).toBe("h264,yuv420p");
            // x264 writes its settings into the stream: a copy still carries the source's, a re-encode would say crf=23.
            expect((await readFile(rendition.path)).includes("crf=40.0")).toBe(true);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("answers that it is still being made when it takes longer than one request waits", async () => {
        const root = await mkdtemp(join(tmpdir(), "ws-playable-"));
        try {
            const clip = join(root, "clip.wmv");
            writeClip(clip, "320x240", ["-c:v", "wmv2"]);
            expect(await playableMedia(root, clip, 0)).toBe("rendering");
            // The render went on without the request that started it; the next ask finds it.
            expect(made(await playableMedia(root, clip)).type).toBe("video/mp4");
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("streams through GET /workspace/media?playable in ranges, typed as the AAC it is", async () => {
        const root = await mkdtemp(join(tmpdir(), "ws-playable-"));
        writeTone(join(root, "take.aiff"), "pcm_s16be");
        await writeFile(join(root, "broken.wav"), "not a recording");
        // No `auth` means loopback mode, so the ticket gate passes through.
        const app = createApp(services({ workspace: workspacePaths(root), files: fakeFiles({ size: statWorkspaceFileSize }) }));
        try {
            const whole = await app.request("/workspace/media?path=take.aiff&playable=1");
            expect(whole.status).toBe(200);
            expect(whole.headers.get("content-type")).toBe("audio/mp4");
            expect(whole.headers.get("accept-ranges")).toBe("bytes");
            const length = Number(whole.headers.get("content-length"));
            expect((await whole.arrayBuffer()).byteLength).toBe(length);

            const head = await app.request("/workspace/media?path=take.aiff&playable=1", { headers: { range: "bytes=0-7" } });
            expect(head.status).toBe(206);
            expect(head.headers.get("content-range")).toBe(`bytes 0-7/${length}`);
            // An MP4 opens on its `ftyp` box.
            expect(Buffer.from(await head.arrayBuffer()).subarray(4, 8).toString()).toBe("ftyp");

            // Without the flag the file is streamed as it is.
            expect((await app.request("/workspace/media?path=take.aiff")).headers.get("content-type")).toBe("audio/aiff");
            expect((await app.request("/workspace/media?path=broken.wav&playable=1")).status).toBe(415);
            expect((await app.request("/workspace/media?path=gone.wav&playable=1")).status).toBe(404);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
