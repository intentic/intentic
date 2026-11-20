import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "@intentic/constants/node";
import { askSocket } from "./castd-control.js";
import { type CastdDeps, CastdProcess, type CastdSpec, isCastdProcess, killQuietly, pidFilesOnDisk, spawnDetached } from "./castd-process.js";
import { CAST_DIR, ensureMediaKey } from "./media-token.js";

/* castd, one per X display that has a watched window: the media daemon that captures the display, encodes it and serves
   the picture, sound and the person's input on its own Unix socket (`<cast dir>/<session>.sock`), which netd relays the
   editor's media socket to (browser-wire's BROWSER_MEDIA_PATH). This module keeps one per display key and finds the
   binary; castd-process.ts starts, adopts, restarts and stops it. Nothing here reads a frame.

   Without a castd binary nothing starts, and every window is shown the old way (live-view.ts: ffmpeg and stills). */

export type { CastdSpec, CastFraming } from "./castd-process.js";
export type { CastGeometry } from "./castd-control.js";
export type Castd = CastdProcess;

// The image installs castd here, beside its patched Xvfb and x264 (image-packs/castd.Dockerfile).
export const IMAGE_CASTD = "/opt/castd/bin/castd";
// A developer's build in the checkout (`cargo build --release` in _sandbox/castd, the sandbox package's sibling). An
// installed daemon (the image's /opt/sandbox) has no such sibling, and the path names nothing there.
const devCastd = (): string => join(packageRoot(import.meta.url), "../castd/target/release/castd");

// Where castd is: `INTENTIC_CASTD` when set (empty turns castd off), else the image's, else a dev build; undefined when
// there is none.
export const castdBinary = (env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = existsSync): string | undefined => {
    const named = env["INTENTIC_CASTD"];
    if (named !== undefined) {
        return named !== "" && exists(named) ? named : undefined;
    }
    return [IMAGE_CASTD, devCastd()].find((path) => exists(path));
};

// The name castd serves under and the media path carries, from the display's key: the key itself where it is already a
// valid name, else a readable stem with a hash, since keys are account ids with `@` and `.` in them. One per display,
// shared by every browser session on it, since the picture is the display's.
const NAME = /^[A-Za-z0-9_-]{1,58}$/u;
export const castSessionOf = (key: string): string => {
    if (NAME.test(key)) {
        return `cast-${key}`;
    }
    const stem = key.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 40);
    return `cast-${stem}-${createHash("sha256").update(key).digest("hex").slice(0, 8)}`;
};

// When the daemon last dropped every castd's viewers (dropCastdViewers), carried to a castd started after it.
let droppedAt = 0;

export const castdDroppedAt = (): number => droppedAt;

const defaultDeps = (): CastdDeps => ({
    dir: CAST_DIR,
    // The daemon names the workspace's own directory at boot (netd-door.ts); this one serves a test.
    recordDir: join(CAST_DIR, "recordings"),
    droppedAt: () => castdDroppedAt(),
    binary: () => castdBinary(),
    spawn: spawnDetached,
    ask: askSocket,
    // The display's socket file: an X server gone with its display leaves none (display.ts removes a stale one).
    displayUp: async (display) => existsSync(`/tmp/.X11-unix/X${display.replace(/^:/u, "")}`),
    isCastd: isCastdProcess,
    kill: killQuietly,
    pids: pidFilesOnDisk,
    mediaKey: () => ensureMediaKey(CAST_DIR),
    log: () => undefined,
    startMs: 5_000,
});

let deps: CastdDeps | undefined;
const casts = new Map<string, CastdProcess>();

const depsNow = (): CastdDeps => {
    deps ??= defaultDeps();
    return deps;
};

// What castd is started with: the daemon's logger and display probe at boot, a fake spawner in tests.
export const configureCastd = (overrides: Partial<CastdDeps>): void => {
    deps = { ...depsNow(), ...overrides };
};

// Whether castd can serve this sandbox's windows: its binary is there. Read where a choice is made once (a window's
// launch flags, the size of a display), never cached past it.
export const castdAvailable = (): boolean => depsNow().binary() !== undefined;

// The castd serving `key`'s display, started now if it is not running; undefined without a castd binary. A running one
// asked for a different crop moves it; asked for the other framing, or for a display that came back on another number
// (its X server died and the key's next one took a free number), it is started again.
export const ensureCastd = (spec: CastdSpec): CastdProcess | undefined => {
    const now = depsNow();
    if (now.binary() === undefined) {
        return undefined;
    }
    const existing = casts.get(spec.key);
    if (existing !== undefined) {
        if (existing.display === spec.display && existing.framing().kind === spec.framing.kind) {
            if (spec.framing.kind === "crop") {
                void existing.moveCrop(spec.framing.rect);
            }
            return existing;
        }
        existing.stop();
    }
    const castd = new CastdProcess(spec, castSessionOf(spec.key), now);
    casts.set(spec.key, castd);
    return castd;
};

// The directory castd's sockets and their bookkeeping live in: browser-wire's, or a test's own.
export const castdDir = (): string => depsNow().dir;

// The key this sandbox's castds check media tokens with.
export const castdMediaKey = (): Buffer => depsNow().mediaKey().key;

// Where castd writes recordings (`--record-dir`), which the daemon moves them out of once they stop.
export const castdRecordDir = (): string => depsNow().recordDir;

// The castd serving `key`'s display, without starting one.
export const castdOf = (key: string): CastdProcess | undefined => casts.get(key);

/**
 * Ends the media sockets of every running castd's viewers, and has each refuse the tokens minted before now: a member's
 * access was revoked, or every session ended. A viewer still entitled asks its window's socket for a fresh token and
 * dials again (browser-wire's `dropped` close code); one whose access went has no window socket left to ask. A castd
 * started later refuses those tokens too (`--not-before`). Answers how many sockets were ended.
 */
export const dropCastdViewers = async (reason: string, now: number = Date.now()): Promise<number> => {
    droppedAt = Math.max(droppedAt, now);
    const dropped = await Promise.all([...casts.values()].map((castd) => castd.control.dropViewers({ reason })));
    return dropped.reduce<number>((sum, count) => sum + (count ?? 0), 0);
};

// Stops `key`'s castd: its display is going (display.ts releaseDisplay).
export const stopCastd = (key: string): void => {
    casts.get(key)?.stop();
    casts.delete(key);
};
