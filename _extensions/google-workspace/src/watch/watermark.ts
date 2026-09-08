import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runtimeDir } from "../google/paths.js";

// How far the watcher has read, kept on disk per connection. Without it a restart either replays the inbox or silently
// skips what arrived while down. A missing or unreadable file re-baselines: dispatches nothing and starts from now,
// since a flood is worse than a gap the owner can see.

export interface Watermark {
    // Gmail's own cursor; everything since it is what the account hasn't been told about.
    readonly historyId?: string;
    // Calendar has no cursor: event id to its start, kept only while still inside a polling window.
    readonly announced?: Readonly<Record<string, string>>;
}

export const watermarkPath = (workspaceRoot: string, name: string): string => join(runtimeDir(workspaceRoot, name), "watch.json");

export const readWatermark = async (path: string): Promise<Watermark> => {
    let raw: string;
    try {
        raw = await readFile(path, "utf8");
    } catch {
        return {};
    }
    try {
        const parsed = JSON.parse(raw) as Watermark;
        return {
            ...(typeof parsed.historyId === "string" ? { historyId: parsed.historyId } : {}),
            ...(typeof parsed.announced === "object" && parsed.announced !== null ? { announced: parsed.announced } : {}),
        };
    } catch {
        return {};
    }
};

export const writeWatermark = async (path: string, mark: Watermark): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(mark));
};

// Forgets announced events once their start is well behind any window that could resurface them; unpruned this map is
// the only unbounded growth in the watcher.
export const pruneAnnounced = (announced: Readonly<Record<string, string>>, now: number, keepMs: number): Record<string, string> =>
    Object.fromEntries(Object.entries(announced).filter(([, start]) => now - new Date(start).getTime() < keepMs));
