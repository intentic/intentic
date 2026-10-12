import { createEngineClient } from "@intentic/iq-engine/host";
import type { Logger } from "pino";
import type { Config } from "../env.config.js";
import { statePath } from "../state-paths.js";
import { applyWorkload } from "../workload/workload-class.js";

// A full embeddings rebuild is slow; logged at a human cadence so the load has a name while it runs. A backlog that
// clears before its first interval (a save's few dozen chunks, done in seconds) is a trace: those pairs were five
// hundred info lines in five days that named no load anyone felt.
const BACKLOG_LOG_MS = 30_000;
// 2.5 GiB: under the child's inherited 3 GiB heap cap, so a runaway is replaced before V8 makes it a fatal error.
const IQ_MEMORY_CEILING_BYTES = 2.5 * 1024 * 1024 * 1024;
// Ten minutes nobody searched: the child (index plus both ML models, ~350 MB measured idle on 2026-10-10, most of it
// swapped) is let go, and the next search or turn forks it again, paying the models' load once. Every turn asks for
// context, so a sandbox in use never reaches this; one left alone among a dozen others on a PC stops holding it.
const IQ_IDLE_EXIT_MS = 10 * 60_000;

// The workspace's code-search engine, run in a child process the daemon supervises and replaces past its memory ceiling.
export const createCodeSearchEngine = (
    config: Pick<Config, "iqModelDir" | "iqRgPath">,
    workspaceRoot: string,
    logger: Logger,
): ReturnType<typeof createEngineClient> => {
    // The backlog being worked through now: when it started or was last written, what it started with, and whether
    // it has written an info line, which is what earns it a "complete" line.
    let backlog: { loggedAt: number; startedAt: number; startedWith: number; told: boolean } | undefined;
    // The engine runs in a child process, most of this daemon's RSS; a dead child only loses its own searches.
    const iq = createEngineClient({
        root: workspaceRoot,
        indexDir: statePath(workspaceRoot, ".intentic/local/cache/", "iq"),
        // A service: a dead engine costs a re-sweep, and it holds more memory than anything else the daemon runs.
        onSpawn: (pid) => void applyWorkload(pid, { class: "service" }),
        // An index pass failing after warm() has no caller to reject; without this it silently stops tracking disk.
        onIndexError: (error) => logger.warn({ err: error }, "iq index pass failed, search results may be stale"),
        onIndexProgress: (remaining) => {
            const now = Date.now();
            if (remaining === 0) {
                if (backlog !== undefined) {
                    const done = { startedWith: backlog.startedWith, durationMs: now - backlog.startedAt };
                    logger[backlog.told ? "info" : "debug"](done, "iq index embeddings complete: semantic search at full coverage");
                    backlog = undefined;
                }
                return;
            }
            if (backlog === undefined) {
                backlog = { loggedAt: now, startedAt: now, startedWith: remaining, told: false };
                logger.debug({ remaining }, "iq index building embeddings: semantic search fills in as it goes");
                return;
            }
            if (now - backlog.loggedAt < BACKLOG_LOG_MS) {
                return;
            }
            backlog.loggedAt = now;
            backlog.told = true;
            logger.info({ remaining, startedWith: backlog.startedWith }, "iq index building embeddings: semantic search fills in as it goes");
        },
        // The query worker owns the semantic scan and cross-encoder; losing it narrows a search to keyword matching.
        onQueryError: (error) => logger.warn({ err: error }, "iq query worker failed, search fell back to keyword matching"),
        // Well clear of the working set: the child holds the index and the ML models, and was measured at 1.64 GB
        // having grown from 691 MB in half an hour. The point is to bound memory that is not coming back, not to
        // ration what the engine legitimately needs — a ceiling low enough to fire in normal use announces itself
        // in the log below, which is the signal to raise it rather than to keep paying for re-sweeps.
        memoryCeilingBytes: IQ_MEMORY_CEILING_BYTES,
        idleExitMs: IQ_IDLE_EXIT_MS,
        onIdleExit: ({ pid, idleMs }) => logger.info({ enginePid: pid, idleMs }, "iq search engine let go after going unasked; the next search starts it"),
        onRecycle: ({ pid, rssBytes }) =>
            logger.warn(
                { enginePid: pid, rssBytes, ceilingBytes: IQ_MEMORY_CEILING_BYTES },
                "iq search engine passed its memory ceiling and was replaced",
            ),
        ...(config.iqModelDir !== "" ? { modelDir: config.iqModelDir } : {}),
        ...(config.iqRgPath !== "" ? { rgPath: config.iqRgPath } : {}),
    });
    // Named once at boot: from outside the engine is one more node child, and this answers which holds the memory.
    logger.info({ enginePid: iq.pid() }, "iq search engine running in its own process");
    return iq;
};
