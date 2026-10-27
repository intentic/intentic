import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { encodePng, type Pixels } from "../png.js";
import type { Rect, ScreenFrame } from "../types.js";

/* THE SCREEN WITHOUT A SCRIPT, ON WINDOWS (2026-10-27). The PowerShell capture (Add-Type declaring the DPI call beside
   CopyFromScreen) is what Defender's script scanner reads as screen-grabbing malware: 54 `screenshot`, `ui_act` and
   `device` calls failed on the owner's two Windows machines from 10-09 to 10-26 with "This script contains malicious
   content and has been blocked by your antivirus software". `intentic-launch.exe` (_devices/win-launcher) ships signed
   beside the agent on every Windows device and now makes the same GDI calls itself (`--capture`, `--frame`), so it is
   asked first; the script stays as the fallback for a launcher that predates those flags, which refuses them. */

const LAUNCHER = "intentic-launch.exe";

// Beside the running binary, where intentic-machine keeps it (local-agent launcher.ts); never looked up on PATH.
export const nativeLauncher = (execPath: string = process.execPath): string | undefined => {
    const candidate = join(dirname(execPath), LAUNCHER);
    return existsSync(candidate) ? candidate : undefined;
};

// What the launcher writes: `IRAW`, little-endian width and height, then 4 bytes a pixel (blue, green, red, unused),
// rows top to bottom. Undefined for anything else, including a short file.
export const rawToPixels = (raw: Buffer): Pixels | undefined => {
    if (raw.length < 12 || raw.toString("latin1", 0, 4) !== "IRAW") {
        return undefined;
    }
    const width = raw.readUInt32LE(4);
    const height = raw.readUInt32LE(8);
    if (width === 0 || height === 0 || raw.length < 12 + width * height * 4) {
        return undefined;
    }
    const data = new Uint8Array(width * height * 3);
    for (let pixel = 0, from = 12, to = 0; pixel < width * height; pixel++, from += 4, to += 3) {
        data[to] = raw[from + 2] ?? 0;
        data[to + 1] = raw[from + 1] ?? 0;
        data[to + 2] = raw[from] ?? 0;
    }
    return { width, height, data };
};

// Exit and what it printed, for a launcher that has no console of its own.
const ask = (launcher: string, args: readonly string[]): Promise<{ readonly code: number | null; readonly out: string; readonly err: string }> =>
    new Promise((resolvePromise) => {
        const child = spawn(launcher, [...args], { windowsHide: true });
        let out = "";
        let err = "";
        child.stdout?.on("data", (chunk: Buffer) => {
            out += chunk.toString();
        });
        child.stderr?.on("data", (chunk: Buffer) => {
            err += chunk.toString();
        });
        child.on("error", (error) => resolvePromise({ code: null, out, err: error.message }));
        child.on("close", (code) => resolvePromise({ code, out, err }));
    });

/** The desktop (or `region` of it, in screenshot pixels) as a PNG, or why the launcher could not; undefined without one. */
export const nativeCapture = async (rawPath: string, region: Rect | undefined, launcher = nativeLauncher()): Promise<Buffer | string | undefined> => {
    if (launcher === undefined) {
        return undefined;
    }
    const regionArgs =
        region === undefined ? [] : ["--region", [region.x, region.y, region.width, region.height].map((value) => Math.round(value)).join(",")];
    try {
        const said = await ask(launcher, ["--capture", rawPath, ...regionArgs]);
        if (said.code !== 0) {
            return `${LAUNCHER}: ${said.err.trim().slice(-300) || `exited with code ${said.code}`}`;
        }
        // allow(silent-catch): a launcher that wrote nothing is answered just below in its own words
        const pixels = rawToPixels(await readFile(rawPath).catch(() => Buffer.alloc(0)));
        return pixels === undefined ? `${LAUNCHER}: exited cleanly without writing an image` : encodePng(pixels);
    } finally {
        // allow(silent-catch): removing the scratch file is tidying; the capture has already answered
        await rm(rawPath, { force: true }).catch(() => undefined);
    }
};

/** The virtual desktop's size and top-left as the launcher reads it, or undefined (no launcher, or one without `--frame`). */
export const nativeFrame = async (launcher = nativeLauncher()): Promise<ScreenFrame | undefined> => {
    if (launcher === undefined) {
        return undefined;
    }
    const said = await ask(launcher, ["--frame"]);
    const [width, height, left, top] = said.out.trim().split(/\s+/u).map(Number);
    if (said.code !== 0 || width === undefined || height === undefined || !(width > 0) || !(height > 0)) {
        return undefined;
    }
    return { width, height, origin: { x: left ?? 0, y: top ?? 0 } };
};
