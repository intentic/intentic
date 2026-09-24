import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { errorMessage, undefinedIfMissing } from "@intentic/base/errors";
import { dirname, join } from "node:path";
import { runtimeDir } from "../google/paths.js";

// How far the watcher has read, kept on disk per connection. Without it a restart either replays the inbox or silently
// skips what arrived while down. A missing or corrupt file re-baselines: dispatches nothing and starts from now, since a
// flood is worse than a gap the owner can see. A read that failed throws: the baseline would be written over it.

export interface Watermark {
    // Gmail's own cursor; everything since it is what the account hasn't been told about.
    readonly historyId?: string;
    // Calendar has no cursor: event id to its start, kept only while still inside a polling window.
    readonly announced?: Readonly<Record<string, string>>;
}

export const watermarkPath = (workspaceRoot: string, name: string): string => join(runtimeDir(workspaceRoot, name), "watch.json");

// A corrupt file is reported through `onUnreadable`; fields of the wrong type are dropped one by one, as a loose read.
export const readWatermark = async (path: string, onUnreadable: (detail: string) => void): Promise<Watermark> => {
    const raw = await readFile(path, "utf8").catch(undefinedIfMissing);
    if (raw === undefined) {
        return {};
    }
    let parsed: Watermark | null;
    try {
        parsed = JSON.parse(raw) as Watermark | null;
    } catch (error) {
        onUnreadable(`not JSON: ${errorMessage(error)}`);
        return {};
    }
    if (typeof parsed !== "object" || parsed === null) {
        onUnreadable("not a watermark: the file holds no object");
        return {};
    }
    return {
        ...(typeof parsed.historyId === "string" ? { historyId: parsed.historyId } : {}),
        ...(typeof parsed.announced === "object" && parsed.announced !== null ? { announced: parsed.announced } : {}),
    };
};

// Written beside and renamed over: the mail and calendar polls save concurrently, and a crash mid-write must leave the
// previous mark rather than a torn one.
export const writeWatermark = async (path: string, mark: Watermark): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    const staged = `${path}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(staged, JSON.stringify(mark));
    await rename(staged, path);
};

// Forgets announced events once their start is well behind any window that could resurface them; unpruned this map is
// the only unbounded growth in the watcher.
export const pruneAnnounced = (announced: Readonly<Record<string, string>>, now: number, keepMs: number): Record<string, string> =>
    Object.fromEntries(Object.entries(announced).filter(([, start]) => now - new Date(start).getTime() < keepMs));
