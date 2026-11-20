import { randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, CDPSession } from "playwright";
import { deleteDownloadFiles, downloadsDir, incomingDir, restoreDownloads, safeFileName, settleDownload } from "./download-files.js";
import { createDownloadTracker, DOWNLOAD_POLICY, type DownloadRecord, expiredDownloads, LISTED_DOWNLOADS, wireDownload } from "./download-tracker.js";
import type { BrowserDownload } from "@intentic/sandbox-contract/schemas/browser-tools";

// The downloads of the person's own window (own-browser.ts), into its profile's own downloads folder
// (download-files.ts) rather than wherever Chromium's default would put them, with no dialog: Chromium's save dialog
// opens on the sandbox's disk, in a picture the person can barely work. Each is listed with its window
// (window-summary.ts) and offered to the person from there. Any browser this daemon starts itself can be armed the same
// way, keyed by its profile.
//
// An agent's window is left alone: @playwright/mcp set that browser's download behaviour for its own `download` events,
// and the agent's own tools read the file where Playwright put it. Taking the behaviour over would leave them waiting
// on a file that never arrives.

const listeners = new Set<(profile: string) => void>();
const tracker = createDownloadTracker((profile) => {
    for (const listener of listeners) {
        listener(profile);
    }
});

/** Hears which profile's downloads changed: a window of that profile has a new list to show. */
export const onDownloadsChanged = (listener: (profile: string) => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};

interface ProfileDownloads {
    readonly dir: string;
    // Each running browser's own DevTools session on the profile, what a cancel is said on.
    readonly sessions: Set<CDPSession>;
    // Ids this daemon asked to stop, so Chromium's `canceled` reads as the person's doing rather than a failure.
    readonly stopping: Set<string>;
}

const profiles = new Map<string, ProfileDownloads>();

/** A profile's recent downloads as its windows show them, newest first; undefined for one whose downloads are not kept here. */
export const profileDownloads = (profile: string): BrowserDownload[] | undefined =>
    profiles.has(profile) ? tracker.list(profile).slice(0, LISTED_DOWNLOADS).map(wireDownload) : undefined;

/** Every kept download, every profile's, newest first. */
export const allDownloads = (): BrowserDownload[] => tracker.list().map(wireDownload);

/** One download as the daemon holds it. */
export const findDownload = (id: string): DownloadRecord | undefined => tracker.get(id);

// The policy's sweep over one profile: what it no longer keeps leaves the list and the disk.
const sweep = async (profile: string, now = Date.now()): Promise<void> => {
    const held = profiles.get(profile);
    if (held === undefined) {
        return;
    }
    for (const record of expiredDownloads(tracker.list(profile), now)) {
        tracker.remove(record.id);
        await deleteDownloadFiles(held.dir, record.id);
    }
};

// The profile's folder, opened once per daemon: what an earlier one left is listed again, then swept.
const openProfile = async (root: string, profile: string): Promise<ProfileDownloads> => {
    const known = profiles.get(profile);
    if (known !== undefined) {
        return known;
    }
    const dir = downloadsDir(root, profile);
    const held: ProfileDownloads = { dir, sessions: new Set(), stopping: new Set() };
    profiles.set(profile, held);
    for (const record of await restoreDownloads(dir, profile)) {
        tracker.add(record);
    }
    await mkdir(incomingDir(dir), { recursive: true });
    await sweep(profile);
    return held;
};

// Chromium's progress event, in the words this list uses.
interface ProgressEvent {
    readonly guid: string;
    readonly totalBytes: number;
    readonly receivedBytes: number;
    readonly state: "inProgress" | "completed" | "canceled";
}

const landed = async (held: ProfileDownloads, record: DownloadRecord): Promise<void> => {
    try {
        const file = await settleDownload(held.dir, record.id, record.name);
        tracker.update(record.id, (entry) => {
            entry.file = file;
            entry.state = "done";
            entry.finishedAt = Date.now();
            entry.totalBytes ??= entry.receivedBytes;
        });
        await sweep(record.profile);
    } catch {
        tracker.update(record.id, (entry) => {
            entry.state = "failed";
            entry.finishedAt = Date.now();
        });
    }
};

const onProgress = (held: ProfileDownloads, event: ProgressEvent): void => {
    const record = tracker.get(event.guid);
    if (record === undefined || record.state !== "progress") {
        return;
    }
    if (event.state === "completed") {
        record.receivedBytes = event.receivedBytes;
        void landed(held, record);
        return;
    }
    if (event.state === "canceled") {
        const asked = held.stopping.delete(record.id);
        tracker.update(record.id, (entry) => {
            entry.state = asked ? "canceled" : "failed";
            entry.finishedAt = Date.now();
        });
        void deleteDownloadFiles(held.dir, record.id);
        return;
    }
    tracker.update(record.id, (entry) => {
        entry.receivedBytes = event.receivedBytes;
        entry.totalBytes = event.totalBytes > 0 ? event.totalBytes : undefined;
    });
    // One file bigger than the whole profile keeps is stopped as it passes that, rather than filling the disk first:
    // the policy only sweeps what has landed. Not the person's stop, so it reads as failed.
    if (event.receivedBytes > DOWNLOAD_POLICY.maxBytes) {
        for (const session of held.sessions) {
            // allow(silent-catch): a browser closing under the stop fails the download by itself.
            void session.send("Browser.cancelDownload", { guid: record.id }).catch(() => undefined);
        }
    }
};

/**
 * Downloads `context`'s browser (one this daemon started, on `profile`) into the profile's folder and lists them; answers once
 * Chromium has been told. Ends with the browser: a download still arriving then is one that failed.
 */
export const armDownloads = async (input: { readonly context: BrowserContext; readonly profile: string; readonly root: string }): Promise<void> => {
    const browser = input.context.browser();
    if (browser === null) {
        return;
    }
    const held = await openProfile(input.root, input.profile);
    const session = await browser.newBrowserCDPSession();
    held.sessions.add(session);
    session.on("Browser.downloadWillBegin", (event: { guid: string; url: string; suggestedFilename: string }) => {
        tracker.add({
            id: event.guid,
            profile: input.profile,
            name: safeFileName(event.suggestedFilename),
            url: event.url,
            state: "progress",
            receivedBytes: 0,
            totalBytes: undefined,
            startedAt: Date.now(),
            finishedAt: undefined,
            file: undefined,
        });
    });
    session.on("Browser.downloadProgress", (event: ProgressEvent) => onProgress(held, event));
    browser.once("disconnected", () => {
        held.sessions.delete(session);
        if (held.sessions.size > 0) {
            return;
        }
        for (const record of tracker.list(input.profile)) {
            if (record.state === "progress") {
                tracker.update(record.id, (entry) => {
                    entry.state = "failed";
                    entry.finishedAt = Date.now();
                });
                void deleteDownloadFiles(held.dir, record.id);
            }
        }
    });
    // allowAndName: Chromium saves each file under its guid without asking, and says so as it goes (eventsEnabled).
    await session.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: incomingDir(held.dir), eventsEnabled: true });
};

/** Stops a download still arriving; one already finished is left as it is. */
export const cancelDownload = async (id: string): Promise<void> => {
    const record = tracker.get(id);
    const held = record === undefined ? undefined : profiles.get(record.profile);
    if (record === undefined || held === undefined || record.state !== "progress") {
        return;
    }
    held.stopping.add(id);
    for (const session of held.sessions) {
        // allow(silent-catch): a browser closing under the cancel fails the download by itself.
        await session.send("Browser.cancelDownload", { guid: id }).catch(() => undefined);
    }
};

/** Stops it if it is arriving, deletes its file and takes it off the list. */
export const removeDownload = async (id: string): Promise<void> => {
    const record = tracker.get(id);
    const held = record === undefined ? undefined : profiles.get(record.profile);
    if (record === undefined || held === undefined) {
        return;
    }
    if (record.state === "progress") {
        await cancelDownload(id);
    }
    tracker.remove(id);
    await deleteDownloadFiles(held.dir, id);
};

/** A file the daemon made for the person (a printed page), listed as a finished download of the profile. */
interface FinishedDownload {
    readonly root: string;
    readonly profile: string;
    readonly name: string;
    readonly url: string;
}

// Lists a file the daemon made itself as a finished download of `profile`; `place` puts it at the path it is given and
// answers its length.
const listFinished = async (input: FinishedDownload, place: (file: string) => Promise<number>): Promise<DownloadRecord> => {
    const held = await openProfile(input.root, input.profile);
    const id = randomUUID();
    const name = safeFileName(input.name);
    const folder = join(held.dir, id);
    await mkdir(folder, { recursive: true });
    const file = join(folder, name);
    const bytes = await place(file);
    const now = Date.now();
    const record: DownloadRecord = {
        id,
        profile: input.profile,
        name,
        url: input.url,
        state: "done",
        receivedBytes: bytes,
        totalBytes: bytes,
        startedAt: now,
        finishedAt: now,
        file,
    };
    tracker.add(record);
    await sweep(input.profile);
    return record;
};

export const addFinishedDownload = (input: FinishedDownload & { readonly bytes: Uint8Array }): Promise<DownloadRecord> =>
    listFinished(input, async (file) => {
        await writeFile(file, input.bytes);
        return input.bytes.byteLength;
    });

// The same for a file already on disk (a window's recording, which castd wrote as it went): moved in, never read.
export const addFinishedDownloadFile = (input: FinishedDownload & { readonly from: string; readonly move: (from: string, to: string) => Promise<void> }): Promise<DownloadRecord> =>
    listFinished(input, async (file) => {
        await input.move(input.from, file);
        return (await stat(file)).size;
    });
