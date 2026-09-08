import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Global setup runs in the runner process and specs run in workers, so nothing an object holds survives; a file does.
// Addresses are decided at run time (ports reserved, host probed), so no constant could work. A stood-down run writes
// this file too, carrying the reason, so a spec can skip with it.

const CACHE = join(import.meta.dirname, `..`, `.cache`);

// Named here, not in the config, so the two can't drift; global setup must write it even standing down.
export const STORAGE_STATE = join(CACHE, `storage-state.json`);

const FILE = join(CACHE, `world.json`);

export interface WorldFile {
    /** Set when the tier did not run; every spec skips with this sentence as its reason. */
    readonly standDown?: string;
    readonly apiUrl?: string;
    /** The api as a container elsewhere on this machine reaches it, what the compose bootstrap curls. */
    readonly apiHostUrl?: string;
    readonly webUrl?: string;
    readonly databaseUrl?: string;
    readonly apiInternalUrl?: string;
    readonly betterAuthSecret?: string;
}

export const writeWorldFile = (world: WorldFile): void => {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(world, undefined, 4));
};

export const readWorldFile = (): WorldFile => {
    try {
        return JSON.parse(readFileSync(FILE, `utf8`)) as WorldFile;
    } catch {
        return { standDown: `the onboarding world was never written, global setup did not run` };
    }
};
