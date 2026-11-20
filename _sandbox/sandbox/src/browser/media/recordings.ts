import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { BrowserRecording } from "@intentic/sandbox-contract/schemas/browser-tools";
import { errnoCode } from "@intentic/base/errors";
import { statePath } from "../../state-paths.js";
import type { CastRecording } from "./castd-control.js";
import { type Castd, castdRecordDir } from "./castd.js";

/* Recordings of a window's picture, made by castd (`POST /record/start?file=`, `POST /record/stop?id=`): the H.264
   stream it already encodes, rewrapped as an MP4, nothing encoded again, costing the window almost nothing. Sound is not
   in it. castd writes it to a file in its `--record-dir` as it goes (castRecordingsDir, on the workspace's disk), so
   neither castd nor this daemon ever holds the video; once it stops, the file is moved where it is kept. Two kinds:

   - The person's: Record in a window's menu, stopped from the same place or by itself at castd's longest (five minutes
     by default), and listed with the window's downloads (downloads/browser-downloads.ts addFinishedDownloadFile), where
     "Save to my computer" and "Save to workspace" take it on, and the downloads' own policy ages it out.
     recording.routes.ts serves it. One per window: a second start answers the one running or starting.
   - An agent's turn: with the sandbox's `recordAgentBrowsing` on, from a turn's first browser call that has a window to
     its end (browser-router.ts), kept under the conversation's artifacts as one file per stretch of castd's longest,
     and aged out by TURN_RECORDING_POLICY. agent-recording.ts drives it. */

// Where castd writes recordings while they run: beside the browser profiles' downloads, under `.intentic/local/browser/`,
// which the workspace's file routes never open.
export const castRecordingsDir = (root: string): string => statePath(root, ".intentic/local/browser/", "recordings");

// One recording castd holds, the file it writes, and the stretch it is up to.
export interface Running {
    readonly castd: Pick<Castd, "control">;
    readonly id: number;
    readonly startedAt: number;
    readonly maxSeconds: number;
    readonly file: string;
}

// A stopped recording: the MP4 castd wrote, and its length.
export interface Recorded {
    readonly file: string;
    readonly bytes: number;
}

// The file names castd is told to write: one this daemon made, so nothing else is ever swept with them.
const STAGED = /^rec-[0-9a-f-]{36}\.mp4$/u;
// Past castd's longest a recording can run (an hour, castd's own clamp) and its wait for a stop: a staged file this old
// is one nobody will come for (a daemon that died while it ran).
const STAGED_FOR_MS = 2 * 3_600_000;

// Starts one on `castd`, written to a new file in `dir` (castd's `--record-dir`); undefined when castd would not (an
// old castd, a striped stream).
export const startRecording = async (castd: Pick<Castd, "control">, now: number = Date.now(), dir: string = castdRecordDir()): Promise<Running | undefined> => {
    void sweepStaged(dir, now);
    const name = `rec-${randomUUID()}.mp4`;
    const started: CastRecording | undefined = await castd.control.recordStart(name);
    return started === undefined ? undefined : { castd, id: started.id, startedAt: now, maxSeconds: started.max_seconds, file: join(dir, name) };
};

// Stops it: the MP4 of everything since the start, in its file; undefined for a recording castd no longer holds (it
// outlived castd's longest by more than castd waits for a stop, or castd itself went), or an answer naming any file
// but the one castd was told to write.
export const stopRecording = async (running: Running): Promise<Recorded | undefined> => {
    const stopped = await running.castd.control.recordStop(running.id);
    return stopped === undefined || resolve(stopped.file) !== resolve(running.file) ? undefined : { file: running.file, bytes: stopped.bytes };
};

// Moves a finished file to `target`, its folder made first: a rename on one disk, a copy where the two differ.
export const moveFile = async (from: string, target: string): Promise<void> => {
    await mkdir(dirname(target), { recursive: true });
    try {
        await rename(from, target);
    } catch (error) {
        if (errnoCode(error) !== "EXDEV") {
            throw error;
        }
        await copyFile(from, target);
        await rm(from, { force: true });
    }
};

// Removes the staged files nobody will come for. Best-effort: a file another daemon life is still moving is younger.
export const sweepStaged = async (dir: string, now: number = Date.now()): Promise<void> => {
    // allow(silent-catch): no directory yet is nothing staged.
    const names = await readdir(dir).catch((): string[] => []);
    for (const name of names.filter((entry) => STAGED.test(entry))) {
        // allow(silent-catch): a file gone between the list and the look was moved or swept already.
        const at = await stat(join(dir, name)).catch(() => undefined);
        if (at !== undefined && now - at.mtimeMs > STAGED_FOR_MS) {
            await rm(join(dir, name), { force: true });
        }
    }
};

// When the daemon stops a recording itself, a little before castd would: castd discards one nobody stops a minute after
// its longest, but cuts what it records at the longest whatever happens.
export const autoStopMs = (running: Pick<Running, "maxSeconds">): number => Math.max(5_000, running.maxSeconds * 1000 - 2_000);

const wireRecording = (running: Running): BrowserRecording => ({ startedAt: running.startedAt, maxSeconds: running.maxSeconds });

// A turn's part moved from where castd wrote it to where it is kept.
export const keepRecording = (file: string, recorded: Recorded): Promise<void> => moveFile(recorded.file, file);

// A file name for a recording made at `at`, by the window's label: the clock in it, the way a screen recorder names its
// files, so two of the same window sort by when they were made.
export const recordingName = (label: string, at: Date): string => {
    const clean = label.replace(/[\\/:*?"<>|\u0000-\u001f]+/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 80) || "browser";
    const stamp = at.toISOString().slice(0, 19).replace("T", " ").replaceAll(":", ".");
    return `${clean} ${stamp}.mp4`;
};

// Where an agent turn's recordings go: the conversation's own folder of the browser artifacts.
export const turnRecordingPath = (outputDir: string, conversationId: string, owner: string, at: Date, part: number): string => {
    const who = owner.replace(/[^A-Za-z0-9_.@-]+/gu, "_");
    const stamp = at.toISOString().replaceAll(":", "-").slice(0, 19);
    return join(outputDir, conversationId.replace(/[^A-Za-z0-9_-]+/gu, "_"), `${who}-${stamp}${part > 1 ? `-${part}` : ""}.mp4`);
};

// How long agent turns' recordings are kept, and how much of them: a week and 2 GiB across every conversation, the
// browser downloads' own policy (downloads/download-tracker.ts), the oldest going first. A turn's recording is a record
// of what an agent did, read in the days after it; kept forever, every turn's browsing would fill the sandbox's disk.
export interface RecordingPolicy {
    readonly maxAgeMs: number;
    readonly maxBytes: number;
}

const TURN_RECORDING_POLICY: RecordingPolicy = { maxAgeMs: 7 * 24 * 3_600_000, maxBytes: 2 * 1024 ** 3 };

// What turnRecordingPath names, and nothing else in the artifacts' conversation folders.
const TURN_PART = /^[A-Za-z0-9_.@-]+-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d+)?\.mp4$/u;

interface Part {
    readonly file: string;
    readonly at: number;
    readonly bytes: number;
}

const turnParts = async (outputDir: string): Promise<Part[]> => {
    const parts: Part[] = [];
    // allow(silent-catch): no artifacts folder yet holds no recording.
    const folders = await readdir(outputDir, { withFileTypes: true }).catch(() => []);
    for (const folder of folders.filter((entry) => entry.isDirectory())) {
        // allow(silent-catch): a folder removed between the two reads holds nothing.
        const names = await readdir(join(outputDir, folder.name)).catch((): string[] => []);
        for (const name of names.filter((entry) => TURN_PART.test(entry))) {
            const file = join(outputDir, folder.name, name);
            // allow(silent-catch): a part removed between the list and the look is already gone.
            const at = await stat(file).catch(() => undefined);
            if (at?.isFile() === true) {
                parts.push({ file, at: at.mtimeMs, bytes: at.size });
            }
        }
    }
    return parts;
};

/** Removes the agent turns' recordings the policy no longer keeps, oldest first; answers the files removed. */
export const pruneTurnRecordings = async (outputDir: string, now: number = Date.now(), policy: RecordingPolicy = TURN_RECORDING_POLICY): Promise<string[]> => {
    const newestFirst = (await turnParts(outputDir)).toSorted((left, right) => right.at - left.at);
    const removed: string[] = [];
    let kept = 0;
    for (const part of newestFirst) {
        if (now - part.at > policy.maxAgeMs || kept + part.bytes > policy.maxBytes) {
            await rm(part.file, { force: true });
            removed.push(basename(part.file));
            continue;
        }
        kept += part.bytes;
    }
    return removed;
};

// The windows being recorded at the person's ask, by window name: what their state carries (window-summary.ts).
const windowRecordings = new Map<string, { readonly running: Running; readonly timer: NodeJS.Timeout }>();
// Starts still waiting on castd, by window name: a second ask meanwhile answers the first's.
const starting = new Map<string, Promise<BrowserRecording | undefined>>();

/** The recording under way in window `name`, as its state says it; undefined when none is. */
export const windowRecording = (name: string): BrowserRecording | undefined => {
    const held = windowRecordings.get(name);
    return held === undefined ? undefined : wireRecording(held.running);
};

/** Holds `running` as window `name`'s recording, stopped through `finish` at castd's longest if nobody stops it first. */
const holdWindowRecording = (name: string, running: Running, finish: () => void): void => {
    const timer = setTimeout(finish, autoStopMs(running));
    timer.unref();
    windowRecordings.set(name, { running, timer });
};

/**
 * Starts window `name`'s recording through `start` unless one is under way or starting: one recording per window, so a
 * second ask (a double click, two viewers) answers the one there is instead of starting another castd would hold.
 * Undefined when castd would not record.
 */
export const startWindowRecording = async (name: string, start: () => Promise<Running | undefined>, finish: () => void): Promise<BrowserRecording | undefined> => {
    const held = windowRecording(name);
    if (held !== undefined) {
        return held;
    }
    const pending = starting.get(name);
    if (pending !== undefined) {
        return pending;
    }
    const run = (async (): Promise<BrowserRecording | undefined> => {
        const running = await start();
        if (running === undefined) {
            return undefined;
        }
        holdWindowRecording(name, running, finish);
        return wireRecording(running);
    })();
    starting.set(name, run);
    try {
        return await run;
    } finally {
        starting.delete(name);
    }
};

/** Lets go of window `name`'s recording and hands it back, for its MP4 to be fetched; undefined when none was held. */
export const releaseWindowRecording = (name: string): Running | undefined => {
    const held = windowRecordings.get(name);
    windowRecordings.delete(name);
    clearTimeout(held?.timer);
    return held?.running;
};
