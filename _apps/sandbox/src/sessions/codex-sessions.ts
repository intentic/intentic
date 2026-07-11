import { readdir } from "node:fs/promises";
import { join } from "node:path";

// Codex persists each thread as a rollout under <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<ISO8601>-<threadId>.jsonl
// (the id is the `thread.started` thread_id). The @openai/codex-sdk exposes only start/resumeThread — no
// exists/list API — so the only way to tell which CODEX_HOME minted a thread is to scan candidate sessions/ trees
// for the rollout whose name carries the thread id.
const ownsRollout = (fileName: string, threadId: string): boolean => fileName.startsWith("rollout-") && fileName.endsWith(`-${threadId}.jsonl`);

const homeOwnsThread = async (home: string, threadId: string): Promise<boolean> => {
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

// Which CODEX_HOME minted a thread: the fallback home (codexBase, served by OPENAI_API_KEY) or a connected
// account's home (codexBase/<id>). The connected-account set can change between turns, so a resume must run under
// the home that actually holds the rollout — not whichever account is "first" now. undefined ⇒ no home owns it
// (deleted, or lost in a rebuild) ⇒ the caller emits session-not-found and the next send starts fresh.
export const locateCodexThread = async (
    codexBase: string,
    accountHomes: readonly { home: string; accountId: string }[],
    threadId: string,
): Promise<{ home: string; accountId?: string } | undefined> => {
    if (await homeOwnsThread(codexBase, threadId)) {
        return { home: codexBase };
    }
    for (const account of accountHomes) {
        if (await homeOwnsThread(account.home, threadId)) {
            return account;
        }
    }
    return undefined;
};
