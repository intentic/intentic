import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

// The spend a resumed Claude session carries in. The CLI restores the running total its transcript saved (the last
// `cost-state` record for that session), so a resumed query's first result already counts every earlier turn. Read off
// the transcript's tail; a session with no transcript or no record carries nothing.

// A clean exit leaves the record last, so the first chunk finds it; a crashed exit leaves an older one further up.
export const CHUNK_BYTES = 64 * 1024;
export const TAIL_LIMIT_BYTES = 4 * 1024 * 1024;

const COST_STATE_MARK = `"type":"cost-state"`;

const CostStateSchema = z.object({ type: z.literal("cost-state"), sessionId: z.string(), totalCostUSD: z.number().nonnegative() });

// A session id is the CLI's own UUID; anything else is refused rather than joined into a path.
const SESSION_ID = /^[\w-]+$/;

// The CLI files a transcript under its cwd, sanitized; the id alone finds it wherever the turn ran.
const transcriptOf = async (store: string, sessionId: string): Promise<string | undefined> => {
    const projects = join(store, "projects");
    const dirs = await readdir(projects, { withFileTypes: true }).catch(() => []);
    const paths = dirs.filter((dir) => dir.isDirectory()).map((dir) => join(projects, dir.name, `${sessionId}.jsonl`));
    const found = await Promise.all(paths.map(async (path) => ((await stat(path).catch(() => undefined))?.isFile() === true ? path : undefined)));
    return found.find((path) => path !== undefined);
};

// The session's own total on one transcript line, or undefined for any other line.
const totalOn = (line: string, sessionId: string): number | undefined => {
    const start = line.indexOf("{");
    if (start === -1 || !line.includes(COST_STATE_MARK)) {
        return undefined;
    }
    try {
        const parsed = CostStateSchema.safeParse(JSON.parse(line.slice(start)));
        return parsed.success && parsed.data.sessionId === sessionId ? parsed.data.totalCostUSD : undefined;
    } catch {
        return undefined;
    }
};

// The latest total in one read's whole lines, newest first.
const latestIn = (text: Buffer, sessionId: string): number | undefined => {
    for (const line of text.toString("utf8").split("\n").toReversed()) {
        const total = totalOn(line, sessionId);
        if (total !== undefined) {
            return total;
        }
    }
    return undefined;
};

// Walks the file backwards a chunk at a time. The bytes before a chunk's first line break began earlier in the file,
// so they wait for the next read rather than being parsed as a line.
const lastTotal = async (path: string, sessionId: string): Promise<number | undefined> => {
    const file = await open(path, "r");
    try {
        const { size } = await file.stat();
        let end = size;
        let carried = Buffer.alloc(0);
        while (end > 0 && size - end < TAIL_LIMIT_BYTES) {
            const start = Math.max(0, end - CHUNK_BYTES);
            const chunk = Buffer.alloc(end - start);
            await file.read(chunk, 0, chunk.length, start);
            const text = Buffer.concat([chunk, carried]);
            if (start === 0) {
                return latestIn(text, sessionId);
            }
            const cut = text.indexOf(0x0a);
            const total = cut === -1 ? undefined : latestIn(text.subarray(cut + 1), sessionId);
            if (total !== undefined) {
                return total;
            }
            carried = cut === -1 ? text : text.subarray(0, cut);
            end = start;
        }
        return undefined;
    } finally {
        await file.close();
    }
};

// What the resumed session already spent, in USD; 0 for a fresh session, a hand-built request with no store, or a
// transcript that saved no total. Never throws: a missed baseline costs one overcounted result, not the turn.
export const carriedCostOf = async (turn: { readonly sessionId?: string; readonly sessionStore?: string }): Promise<number> => {
    if (turn.sessionId === undefined || turn.sessionStore === undefined || !SESSION_ID.test(turn.sessionId)) {
        return 0;
    }
    const path = await transcriptOf(turn.sessionStore, turn.sessionId);
    if (path === undefined) {
        return 0;
    }
    return (await lastTotal(path, turn.sessionId).catch(() => undefined)) ?? 0;
};
