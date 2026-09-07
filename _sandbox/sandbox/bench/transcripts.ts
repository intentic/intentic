import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/* WHERE THE BENCH CORPORA COME FROM. Every offline bench in this directory reads the same raw material: the
 * `.jsonl` transcripts a history root holds, one file per session, nested however the runtime that wrote them
 * chose to nest. Both corpus builders walked it themselves and the walks were identical, so the shape of
 * "which files count" is stated once here.
 *
 * Synchronous and recursive on purpose: a bench is a script, its cost is the parsing that follows, and a
 * generator would buy nothing but ceremony. `cleaner-bench.mjs` keeps its own copy — it is plain `.mjs` so it
 * can ride the image beside bin/cleaners.mjs with no build step, which is the same split filter-stats.mjs
 * documents. */
export const transcriptFiles = (root: string): string[] => {
    const found: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
            const path = join(dir, entry);
            if (statSync(path).isDirectory()) {
                walk(path);
            } else if (entry.endsWith(".jsonl")) {
                found.push(path);
            }
        }
    };
    walk(root);
    return found;
};
