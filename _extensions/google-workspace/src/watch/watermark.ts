import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runtimeDir } from "../google/paths.js";

/* HOW FAR THE WATCHER HAS READ, kept on disk per connection.
 *
 * This file is the whole correctness story of watching. Without it, a restarted gateway either replays the
 * inbox, waking an agent run for every message it has already handled, or silently skips whatever arrived
 * while it was down. Neither is a thing anyone can be asked to tolerate on their own mail, and the difference
 * between them is one small JSON file.
 *
 * A missing or unreadable file re-baselines: it dispatches nothing and starts watching from now. That is the
 * only safe reading of "I don't know where I was", the alternative is a flood, and a flood is worse than a
 * gap the owner can see. */

export interface Watermark {
    // Gmail's own cursor. Everything since it is what the account has not been told about.
    readonly historyId?: string;
    // Calendar has no such cursor, so what has been dispatched is remembered instead: event id → its start,
    // kept only while the start is recent enough to still be inside a polling window.
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

/* Announced events are forgotten once their start is well behind the window that could still surface them.
 * Unpruned, this map is the only thing in the watcher that grows without bound, a year of meetings in a file
 * re-read every five minutes. */
export const pruneAnnounced = (announced: Readonly<Record<string, string>>, now: number, keepMs: number): Record<string, string> =>
    Object.fromEntries(Object.entries(announced).filter(([, start]) => now - new Date(start).getTime() < keepMs));
