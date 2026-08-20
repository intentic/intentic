import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RankedGroup } from "../types.js";

const ID_LENGTH = 8;
const SPOOL_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface Spool {
    readonly generation: number;
    readonly createdAt: number;
    readonly echo: string;
    readonly unit: string;
    readonly style: "hits" | "paths" | "plain";
    readonly showTags: boolean;
    readonly lead: boolean;
    readonly groups: readonly RankedGroup[];
}

// Cursor = 8-hex spool id + base36 group offset. Short, shell-safe, and decodable without IO.
export const cursorId = (echo: string, scopeKey: string): string =>
    createHash("sha256").update(`${echo}\0${scopeKey}`).digest("hex").slice(0, ID_LENGTH);

export const encodeCursor = (id: string, offset: number): string => `${id}${offset.toString(36)}`;

export const decodeCursor = (cursor: string): { id: string; offset: number } | undefined => {
    if (cursor.length <= ID_LENGTH || !/^[0-9a-f]{8}[0-9a-z]+$/.test(cursor)) {
        return undefined;
    }
    return { id: cursor.slice(0, ID_LENGTH), offset: parseInt(cursor.slice(ID_LENGTH), 36) };
};

const spoolDir = (indexDir: string): string => join(indexDir, "spool");

export const writeSpool = (indexDir: string, id: string, spool: Spool): void => {
    const dir = spoolDir(indexDir);
    mkdirSync(dir, { recursive: true });
    // Prune stale spools opportunistically, the spool dir is inside the self-excluded index dir.
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        const age = Date.now() - (statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
        if (age > SPOOL_MAX_AGE_MS) {
            unlinkSync(path);
        }
    }
    writeFileSync(join(dir, `${id}.json`), JSON.stringify(spool));
};

export const readSpool = (indexDir: string, id: string): Spool | undefined => {
    try {
        return JSON.parse(readFileSync(join(spoolDir(indexDir), `${id}.json`), "utf8")) as Spool;
    } catch {
        return undefined;
    }
};
