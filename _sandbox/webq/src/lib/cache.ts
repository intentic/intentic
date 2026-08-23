/* The shared fetch cache: raw HTML keyed by (URL, render mode), never the derived markdown — one cached
 * fetch serves every transform (--raw, --query, different budgets), and parallel subagents researching the
 * same site stop paying the network twice. Entries are single JSON files under a two-hex fan-out; a stale
 * or unreadable entry is a miss, never an error, because the network is the fallback that always exists. */
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { cacheDir } from "./env.js";

export type RenderMode = "static" | "browser";

export interface CacheEntry {
    readonly url: string;
    readonly finalUrl: string;
    readonly status: number;
    readonly contentType: string;
    readonly body: string;
    readonly mode: RenderMode;
    readonly fetchedAt: number;
}

export const DEFAULT_MAX_AGE_S = 900;

const entryPath = (url: string, mode: RenderMode): string => {
    const hash = createHash("sha256").update(`${mode}\n${url}`).digest("hex");
    return join(cacheDir(), hash.slice(0, 2), `${hash}.json`);
};

export const cacheRead = async (url: string, mode: RenderMode, maxAgeS: number): Promise<CacheEntry | undefined> => {
    try {
        const raw = await readFile(entryPath(url, mode), "utf8");
        const entry = JSON.parse(raw) as CacheEntry;
        return Date.now() - entry.fetchedAt <= maxAgeS * 1000 ? entry : undefined;
    } catch {
        return undefined;
    }
};

export const cacheWrite = async (entry: CacheEntry): Promise<void> => {
    const path = entryPath(entry.url, entry.mode);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(entry));
};

export const cacheClear = async (): Promise<void> => {
    await rm(cacheDir(), { recursive: true, force: true });
};
