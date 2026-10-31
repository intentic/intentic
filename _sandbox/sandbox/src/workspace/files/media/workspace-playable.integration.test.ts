import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requires } from "@intentic/testing/requires";
import { createApp } from "../../../app.js";
import { services } from "../../../harness/route-services.testing.js";
import { workspacePaths } from "../../workspace.js";
import { fakeFiles } from "../../workspace-slice.testing.js";
import { statWorkspaceFileSize } from "../workspace-files.js";
import { playableAudio } from "./workspace-playable.js";

/* A recording the browser can't decode plays anyway: the case that started this was a folder of WAVs, and the ones a
   browser refuses are the ADPCM and 64-bit-float kinds, AIFF, CAF, WMA and AMR. Needs ffmpeg, which the browser pack
   brings. */

const ffmpeg = requires(existsSync("/usr/bin/ffmpeg") && existsSync("/usr/bin/ffprobe"), "ffmpeg and ffprobe", {
    absentOnCi: "no CI job that runs the daemon's suites installs the browser pack; the sandbox image carries it",
});

// One second of a tone in `codec`, the encoding no browser decodes inside a WAV.
const writeTone = (path: string, codec: string): void => {
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", codec, path]);
};

const codecOf = (path: string): string =>
    execFileSync("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name", "-of", "csv=p=0", path])
        .toString()
        .trim();

describe.skipIf(!ffmpeg.runs)(ffmpeg.title("a recording the browser can't decode"), () => {
    test("is rendered once as AAC, and the same rendition is handed back until the file changes", async () => {
        const root = await mkdtemp(join(tmpdir(), "ws-playable-"));
        try {
            const take = join(root, "take.wav");
            writeTone(take, "adpcm_ima_wav");
            const first = await playableAudio(root, take);
            expect(first).toMatch(/\.m4a$/);
            expect(codecOf(first!)).toBe("aac");
            expect(await playableAudio(root, take)).toBe(first);

            writeTone(take, "pcm_f64le");
            const changed = await playableAudio(root, take);
            expect(changed).not.toBe(first);
            expect(codecOf(changed!)).toBe("aac");
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("has none where it is no recording or ffmpeg can't read it", async () => {
        const root = await mkdtemp(join(tmpdir(), "ws-playable-"));
        try {
            await writeFile(join(root, "notes.md"), "# notes");
            await writeFile(join(root, "broken.wav"), "not a recording");
            expect(await playableAudio(root, join(root, "notes.md"))).toBeUndefined();
            expect(await playableAudio(root, join(root, "broken.wav"))).toBeUndefined();
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
