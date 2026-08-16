import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/* WHAT THE SPECS ARE TOLD ABOUT THE WORLD, and why it is a file rather than a variable.
 *
 * Playwright's global setup runs in the runner process and the specs run in workers, so nothing an object holds
 * survives the trip. Every address in this tier is also decided at run time — ports are reserved rather than
 * fixed, and the host they sit on is probed for (docker.ts) — so there is no constant a spec could import.
 *
 * A stood-down run writes this file too, carrying the reason. That is what lets a spec say "no Docker here" in
 * its own skip message rather than failing on an address that was never going to exist.
 */

const CACHE = join(import.meta.dirname, `..`, `.cache`);

// Named here rather than in the config so the two cannot drift: playwright.config.ts reads this path before
// global setup has run, which is why global setup must write the file even when the tier stands down.
export const STORAGE_STATE = join(CACHE, `storage-state.json`);

const FILE = join(CACHE, `world.json`);

export interface WorldFile {
    /** Set when the tier did not run. Every spec skips with this sentence as its reason. */
    readonly standDown?: string;
    readonly apiUrl?: string;
    /** The api as a container elsewhere on this machine reaches it — what the compose bootstrap curls. */
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
        return { standDown: `the onboarding world was never written — global setup did not run` };
    }
};
