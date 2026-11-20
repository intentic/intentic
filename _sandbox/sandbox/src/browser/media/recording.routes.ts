import { browserContract } from "@intentic/sandbox-contract/contracts/browser.contract";
import type { BrowserDownload } from "@intentic/sandbox-contract/schemas/browser-tools";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../../app-env.js";
import type { Services } from "../../composition.js";
import { rm } from "node:fs/promises";
import { addFinishedDownloadFile } from "../downloads/browser-downloads.js";
import { wireDownload } from "../downloads/download-tracker.js";
import { browserSessionFront, browserWindowRecord } from "../sessions/browser-sessions.js";
import { windowChanged } from "../state/window-feed.js";
import { castdOf } from "./castd.js";
import { moveFile, recordingName, releaseWindowRecording, startRecording, startWindowRecording, stopRecording } from "./recordings.js";

// The routes behind Record in a window's menu (recordings.ts): start, and stop, which lists the MP4 with the window's
// downloads. A recording castd ends by itself at its longest is listed the same way, with nobody asking.

export type RecordingRoutesDeps = Pick<Services, "workspace" | "logger">;

// Stops window `name`'s recording and lists it; undefined when none was under way or castd no longer held it.
const finish = async (deps: RecordingRoutesDeps, name: string): Promise<BrowserDownload | undefined> => {
    const running = releaseWindowRecording(name);
    const record = browserWindowRecord(name);
    if (running === undefined) {
        return undefined;
    }
    if (record !== undefined) {
        windowChanged(record);
    }
    const recorded = await stopRecording(running);
    if (recorded === undefined || record === undefined) {
        // A window closed while it recorded keeps nothing: its file goes rather than staying behind unlisted.
        if (recorded !== undefined) {
            await rm(recorded.file, { force: true });
        }
        deps.logger.warn({ window: name }, "browser recording: castd held no recording to stop");
        return undefined;
    }
    const page = browserSessionFront(name);
    // allow(silent-catch): a tab navigating as the recording stops has no title to read; its address names the file.
    const title = (await page?.title().catch(() => "")) ?? "";
    const url = page?.url() ?? "about:blank";
    const label = title !== "" ? title : URL.canParse(url) ? new URL(url).hostname : "browser";
    // Moved from where castd wrote it into the window's downloads, whose own policy ages it out; never read here.
    const download = await addFinishedDownloadFile({
        root: deps.workspace.root,
        profile: record.server,
        name: recordingName(`Recording ${label}`, new Date(running.startedAt)),
        url,
        from: recorded.file,
        move: moveFile,
    });
    windowChanged(record);
    return wireDownload(download);
};

// One castd ended at its longest, listed with nobody waiting on the answer: a failure is said in the log.
const kept = async (deps: RecordingRoutesDeps, name: string): Promise<void> => {
    try {
        await finish(deps, name);
    } catch (error) {
        deps.logger.warn({ err: error, window: name }, "browser recording: not kept");
    }
};

export const createRecordingRoutes = (deps: RecordingRoutesDeps) => {
    const i = implement(browserContract).$context<OrpcContext>();
    return {
        startRecording: i.startRecording.handler(async ({ input }) => {
            const record = browserWindowRecord(input.name);
            if (record === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "That browser window is no longer open." });
            }
            // The window's castd, which a view on the media path started: recording is castd's, never the old picture's.
            // One per window: a start while one runs or is starting answers that one.
            const castd = castdOf(record.server);
            const started = await startWindowRecording(
                input.name,
                async () => (castd === undefined ? undefined : startRecording(castd)),
                () => void kept(deps, input.name),
            );
            if (started === undefined) {
                throw new ORPCError("PRECONDITION_FAILED", {
                    message: "This window can't be recorded: the sandbox records only a window it streams the new way, and this one is shown the old way.",
                });
            }
            windowChanged(record);
            return started;
        }),
        stopRecording: i.stopRecording.handler(async ({ input }) => {
            const download = await finish(deps, input.name);
            if (download === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "That window is not being recorded, or its recording is gone." });
            }
            return download;
        }),
    };
};
