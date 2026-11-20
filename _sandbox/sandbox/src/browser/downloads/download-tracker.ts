import type { BrowserDownload } from "@intentic/sandbox-contract/schemas/browser-tools";
import { opt } from "../../opt.js";

// What a browser profile has downloaded, as its download list shows it: one record per file, with where it came from,
// how far it got and where it sits on the sandbox's disk. In memory; the files themselves are the lasting part, laid out
// so a fresh daemon lists them again (download-files.ts). Kept bounded by DOWNLOAD_POLICY, since every one of them is
// disk the sandbox pays for and the person's real copy is the one they save to their computer or the workspace.

export interface DownloadRecord {
    readonly id: string;
    // The profile it belongs to (a window's `server`): `_own` for the person's own window, an account's owner otherwise.
    readonly profile: string;
    name: string;
    readonly url: string;
    state: BrowserDownload["state"];
    receivedBytes: number;
    totalBytes: number | undefined;
    readonly startedAt: number;
    finishedAt: number | undefined;
    // Where the finished file is; undefined until it is one.
    file: string | undefined;
}

export interface DownloadPolicy {
    // A finished download older than this goes, file and all.
    readonly maxAgeMs: number;
    // Past this many bytes of finished files in one profile, the oldest go first.
    readonly maxBytes: number;
    // Past this many finished downloads in one profile, the oldest go first.
    readonly maxCount: number;
}

// A week, 2 GiB and 100 files per profile: about what a person keeps in a browser's own list before clearing it, and a
// ceiling a sandbox's disk can carry for every profile at once.
export const DOWNLOAD_POLICY: DownloadPolicy = { maxAgeMs: 7 * 24 * 3_600_000, maxBytes: 2 * 1024 ** 3, maxCount: 100 };

// How many of a profile's downloads a window's state carries: the list's first screen, not the profile's whole history.
export const LISTED_DOWNLOADS = 20;

const finished = (record: DownloadRecord): boolean => record.state !== "progress";

// The finished downloads the policy no longer keeps, from one profile's records: every one past its age, then the oldest
// until what is left fits both the count and the bytes. One still arriving is never taken, and its bytes are not counted:
// it is not on the list's books until it lands.
export const expiredDownloads = (records: readonly DownloadRecord[], now: number, policy: DownloadPolicy = DOWNLOAD_POLICY): DownloadRecord[] => {
    const done = records.filter(finished).toSorted((left, right) => (right.finishedAt ?? right.startedAt) - (left.finishedAt ?? left.startedAt));
    const expired: DownloadRecord[] = [];
    let count = 0;
    let bytes = 0;
    for (const record of done) {
        const at = record.finishedAt ?? record.startedAt;
        const size = record.state === "done" ? record.receivedBytes : 0;
        if (now - at > policy.maxAgeMs || count + 1 > policy.maxCount || bytes + size > policy.maxBytes) {
            expired.push(record);
            continue;
        }
        count += 1;
        bytes += size;
    }
    return expired;
};

// The record as the wire has it.
export const wireDownload = (record: DownloadRecord): BrowserDownload => ({
    id: record.id,
    name: record.name,
    url: record.url,
    state: record.state,
    receivedBytes: record.receivedBytes,
    ...opt("totalBytes", record.totalBytes),
    startedAt: record.startedAt,
    ...opt("finishedAt", record.finishedAt),
});

export interface DownloadTracker {
    readonly add: (record: DownloadRecord) => void;
    readonly get: (id: string) => DownloadRecord | undefined;
    // Changes one record in place and tells the profile's windows.
    readonly update: (id: string, change: (record: DownloadRecord) => void) => DownloadRecord | undefined;
    readonly remove: (id: string) => DownloadRecord | undefined;
    // Newest first; one profile's, or every profile's.
    readonly list: (profile?: string) => DownloadRecord[];
    // Says a profile's list changed, now: for a removal or a finish, which the windows show at once.
    readonly touch: (profile: string) => void;
}

// `changed` hears which profile's list moved. Progress arrives many times a second on a fast link; it is told at most
// every `throttleMs` per profile, and a finish, a new download or a removal at once.
export const createDownloadTracker = (changed: (profile: string) => void, throttleMs = 250): DownloadTracker => {
    const records = new Map<string, DownloadRecord>();
    const told = new Map<string, number>();
    const pending = new Map<string, ReturnType<typeof setTimeout>>();
    const tellNow = (profile: string): void => {
        clearTimeout(pending.get(profile));
        pending.delete(profile);
        told.set(profile, Date.now());
        changed(profile);
    };
    const tellSoon = (profile: string): void => {
        if (pending.has(profile)) {
            return;
        }
        const wait = Math.max(0, (told.get(profile) ?? 0) + throttleMs - Date.now());
        if (wait === 0) {
            tellNow(profile);
            return;
        }
        pending.set(
            profile,
            setTimeout(() => tellNow(profile), wait),
        );
    };
    return {
        add: (record) => {
            records.set(record.id, record);
            tellNow(record.profile);
        },
        get: (id) => records.get(id),
        update: (id, change) => {
            const record = records.get(id);
            if (record === undefined) {
                return undefined;
            }
            const before = record.state;
            change(record);
            if (record.state !== before) {
                tellNow(record.profile);
            } else {
                tellSoon(record.profile);
            }
            return record;
        },
        remove: (id) => {
            const record = records.get(id);
            if (record !== undefined) {
                records.delete(id);
                tellNow(record.profile);
            }
            return record;
        },
        list: (profile) =>
            [...records.values()].filter((record) => profile === undefined || record.profile === profile).toSorted((left, right) => right.startedAt - left.startedAt),
        touch: tellNow,
    };
};
