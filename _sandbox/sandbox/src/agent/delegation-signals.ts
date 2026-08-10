import { watch, type FSWatcher } from "node:fs";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { noteDelegationSignal } from "./subagents.js";

/* THE SPOOL BETWEEN A DELEGATED CLI'S HOOKS AND THE ROSTER.
 *
 * A delegated `codex exec` runs inside the agent's tmux pane, in the turn's own mount namespace, as a process
 * tree the daemon does not own — so its hooks (codex/codex-config.ts) cannot call into this process and have
 * no socket to be trusted on. What every namespace DOES share is the filesystem outside /work (isolation.ts
 * remounts nothing else), so the hook drops one JSON file per event into this directory and the daemon folds
 * it into the subagent roster. Files, not a socket, on purpose: no auth surface, no listener lifecycle, and a
 * hook that fires while the daemon restarts leaves its news on disk for the next sweep instead of losing it.
 *
 * Each file is write-then-renamed by the hook, so a sweep never reads a half-written one; each is deleted once
 * folded, so the spool is empty whenever nothing is happening. Unparseable files are deleted too — a spool
 * that keeps its garbage re-reads it on every event, forever. */

// Outside the workspace deliberately: /work/.intentic would put every signal through the workspace watcher and
// the state-file table, and an isolated turn's /work is not even the same tree. /tmp is shared with every turn
// namespace, and signals are ephemeral by nature — a reboot owing nothing is correct.
export const AGENT_SIGNALS_DIR = "/tmp/intentic/agent-signals";

// What the codex hook writes (codexSignalScript): its action verb, the delegation id it inherited from the
// pane environment, and codex's own hook payload verbatim.
interface SpoolFile {
    readonly source?: string;
    readonly action?: string;
    readonly delegationId?: string;
    readonly payload?: {
        readonly session_id?: string;
        readonly last_assistant_message?: string;
        // Tool events carry what the delegate is doing (codex normalizes to Claude's tool names); a
        // PermissionRequest's pair is WHAT it is asking to do — the blocked reason a card can show.
        readonly tool_name?: string;
        readonly tool_input?: { readonly command?: string } | null;
    } | null;
}

// Codex's hook verbs onto the roster's signal vocabulary. `session` still folds (it binds the thread);
// anything unrecognized is dropped — a codex that grows a new hook event owes this table a row first.
const CODEX_EVENTS: Record<string, "session" | "working" | "blocked" | "report"> = {
    session: "session",
    working: "working",
    blocked: "blocked",
    report: "report",
};

const fold = (raw: string): void => {
    const parsed = JSON.parse(raw) as SpoolFile;
    if (parsed.source !== "codex" || parsed.delegationId === undefined || parsed.delegationId === "") {
        return;
    }
    const event = parsed.action !== undefined ? CODEX_EVENTS[parsed.action] : undefined;
    if (event === undefined) {
        return;
    }
    const tool = typeof parsed.payload?.tool_name === "string" ? parsed.payload.tool_name : undefined;
    // A blocked signal's summary is its REASON — the permission the delegate is stuck on, delegate's own words
    // for the card ("waiting on permission for Bash: rm -rf build"). Everything else reports the payload's
    // last_assistant_message (Stop), which is the delegate's report.
    const command = typeof parsed.payload?.tool_input?.command === "string" ? `: ${parsed.payload.tool_input.command}` : "";
    const summary =
        event === "blocked" ? `waiting on permission for ${tool ?? "a tool"}${command}`.slice(0, 300) : parsed.payload?.last_assistant_message;
    noteDelegationSignal({
        delegationId: parsed.delegationId,
        event,
        ...(parsed.payload?.session_id !== undefined ? { thread: parsed.payload.session_id } : {}),
        ...(summary !== undefined ? { summary } : {}),
        ...(tool !== undefined ? { tool } : {}),
    });
};

// The hook names files `sig-<pid>-<ns>.json`; the ns stamp orders a burst from one delegate (a Stop landing
// with the working event it followed), and the sort is per-sweep only — cross-sweep order is arrival order.
const stampOf = (name: string): number => Number(/^sig-\d+-(\d+)\.json$/u.exec(name)?.[1] ?? 0);

export interface DelegationSignalsWatcher {
    readonly close: () => void;
    // One pass over whatever is in the spool right now — the watch calls this; tests call it directly.
    readonly sweep: () => Promise<void>;
}

export const watchDelegationSignals = async (dir: string, onError?: (error: unknown) => void): Promise<DelegationSignalsWatcher> => {
    await mkdir(dir, { recursive: true });
    let sweeping = false;
    let again = false;
    const sweep = async (): Promise<void> => {
        // One sweep at a time: a watch event landing mid-sweep marks it dirty rather than racing the readdir,
        // and the tail re-run picks up whatever that event was about.
        if (sweeping) {
            again = true;
            return;
        }
        sweeping = true;
        try {
            do {
                again = false;
                const names = (await readdir(dir)).filter((name) => name.startsWith("sig-")).toSorted((a, b) => stampOf(a) - stampOf(b));
                for (const name of names) {
                    const path = join(dir, name);
                    try {
                        fold(await readFile(path, "utf8"));
                    } catch (error: unknown) {
                        onError?.(error);
                    }
                    // Folded or garbage, it leaves either way — see the header.
                    await rm(path, { force: true }).catch(() => {});
                }
            } while (again);
        } finally {
            sweeping = false;
        }
    };
    let watcher: FSWatcher | undefined;
    try {
        watcher = watch(dir, () => void sweep().catch((error: unknown) => onError?.(error)));
    } catch (error: unknown) {
        // No inotify (an exotic mount) degrades to the initial sweep only — the settle paths still end every
        // delegation, so what is lost is liveness, not correctness.
        onError?.(error);
    }
    await sweep().catch((error: unknown) => onError?.(error));
    return {
        close: () => watcher?.close(),
        sweep,
    };
};
