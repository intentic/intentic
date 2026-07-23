import { readdir } from "node:fs/promises";
import { join } from "node:path";

// Codex persists each thread as a rollout under <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<ISO8601>-<threadId>.jsonl
// (the id is the `thread.started` thread_id). The @openai/codex-sdk exposes only start/resumeThread — no
// exists/list API — so telling whether a thread still exists means scanning the home's sessions/ tree for the
// rollout whose name carries the thread id. There is a single sandbox-wide CODEX_HOME (Codex authenticates
// through the translator subscription, not per-account homes), so this is a plain existence check.
const ownsRollout = (fileName: string, threadId: string): boolean => fileName.startsWith("rollout-") && fileName.endsWith(`-${threadId}.jsonl`);

export const codexThreadExists = async (home: string, threadId: string): Promise<boolean> => {
    const walk = async (dir: string): Promise<boolean> => {
        for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
            if (entry.isDirectory() ? await walk(join(dir, entry.name)) : ownsRollout(entry.name, threadId)) {
                return true;
            }
        }
        return false;
    };
    return walk(join(home, "sessions"));
};
