import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodePng } from "../png.js";
import { nativeCapture, nativeLauncher, rawToPixels } from "./native-capture.js";

// The launcher's raw rows become the PNG every caller reads, and a launcher that is absent or refuses leaves the
// script to answer: what the AV-safe path must never do is answer wrongly.

const raw = (width: number, height: number, bgrx: number[]): Buffer => {
    const head = Buffer.alloc(12);
    head.write("IRAW", 0, "latin1");
    head.writeUInt32LE(width, 4);
    head.writeUInt32LE(height, 8);
    return Buffer.concat([head, Buffer.from(bgrx)]);
};

test("pixels the launcher stores blue first come back in RGB order, rows kept", () => {
    const pixels = rawToPixels(raw(2, 1, [10, 20, 30, 0, 40, 50, 60, 0]));
    expect(pixels).toEqual({ width: 2, height: 1, data: new Uint8Array([30, 20, 10, 60, 50, 40]) });
});

test("anything that is not a whole raw image reads as none", () => {
    expect(rawToPixels(Buffer.from("PNG and more"))).toBeUndefined();
    expect(rawToPixels(raw(2, 2, [1, 2, 3, 0]))).toBeUndefined();
    expect(rawToPixels(raw(0, 1, []))).toBeUndefined();
});

test("no launcher beside the binary means no native path at all", async () => {
    const dir = mkdtempSync(join(tmpdir(), "native-capture-"));
    try {
        expect(nativeLauncher(join(dir, "intentic-machine.exe"))).toBeUndefined();
        writeFileSync(join(dir, "intentic-launch.exe"), "");
        expect(nativeLauncher(join(dir, "intentic-machine.exe"))).toBe(join(dir, "intentic-launch.exe"));
        expect(await nativeCapture(join(dir, "shot.raw"), undefined, undefined)).toBeUndefined();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// A stand-in launcher: a script that writes the raw file it is asked for, or refuses as an older launcher does.
test("a launcher's raw file comes back as a PNG, and a refusal comes back as its words", async () => {
    const dir = mkdtempSync(join(tmpdir(), "native-capture-"));
    try {
        const writer = join(dir, "writer.sh");
        const bytes = raw(1, 1, [1, 2, 3, 0]).toString("base64");
        writeFileSync(writer, `#!/bin/sh\necho ${bytes} | base64 -d > "$2"\n`, { mode: 0o755 });
        const png = await nativeCapture(join(dir, "a.raw"), { x: 0, y: 0, width: 1, height: 1 }, writer);
        if (!Buffer.isBuffer(png)) {
            throw new Error(`expected a PNG, got ${String(png)}`);
        }
        expect(decodePng(png)).toEqual({ width: 1, height: 1, data: new Uint8Array([3, 2, 1]) });

        const old = join(dir, "old.sh");
        writeFileSync(old, `#!/bin/sh\necho "expected --log first." >&2\nexit 1\n`, { mode: 0o755 });
        expect(await nativeCapture(join(dir, "b.raw"), undefined, old)).toBe("intentic-launch.exe: expected --log first.");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
