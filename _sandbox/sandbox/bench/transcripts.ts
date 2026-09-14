import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/* WHERE THE BENCH CORPORA COME FROM. */
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
