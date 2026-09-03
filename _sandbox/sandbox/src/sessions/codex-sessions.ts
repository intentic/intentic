import { readdir } from "node:fs/promises";
import { join } from "node:path";

// Codex persists each thread as a rollout under <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<ISO8601>-<threadId>.jsonl
// (the id is the app-server `thread/start` result). Readiness and transcript backfill must answer without
// starting another app-server process, so finding a thread's rollout means scanning the home's sessions/ tree
// for the file whose name carries the thread id. There is a single sandbox-wide CODEX_HOME (Codex authenticates
// through the translator subscription, not per-account homes), so this is a plain lookup.
const ownsRollout = (fileName: string, threadId: string): boolean => fileName.startsWith("rollout-") && fileName.endsWith(`-${threadId}.jsonl`);

const findRollout = async (home: string, threadId: string): Promise<string | undefined> => {
    const walk = async (dir: string): Promise<string | undefined> => {
        for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) {
                const hit = await walk(path);
                if (hit !== undefined) {
                    return hit;
                }
            } else if (ownsRollout(entry.name, threadId)) {
                return path;
            }
        }
        return undefined;
    };
    return walk(join(home, "sessions"));
};

export const codexThreadExists = async (home: string, threadId: string): Promise<boolean> => (await findRollout(home, threadId)) !== undefined;

