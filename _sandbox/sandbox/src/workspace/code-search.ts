import { createEngineClient } from "@intentic/iq-engine/host";
import type { Logger } from "pino";
import type { Config } from "../env.config.js";
import { statePath } from "../state-paths.js";
import { applyWorkload } from "../workload/workload-class.js";

// A full embeddings rebuild is slow; logged at a human cadence so the load has a name while it runs.
const BACKLOG_LOG_MS = 30_000;
// 2.5 GiB: under the child's inherited 3 GiB heap cap, so a runaway is replaced before V8 makes it a fatal error.
const IQ_MEMORY_CEILING_BYTES = 2.5 * 1024 * 1024 * 1024;

// The workspace's code-search engine, run in a child process the daemon supervises and replaces past its memory ceiling.
export const createCodeSearchEngine = (
    config: Pick<Config, "iqModelDir" | "iqRgPath">,
    workspaceRoot: string,
    logger: Logger,
): ReturnType<typeof createEngineClient> => {
    let backlogLoggedAt = 0;
    let backlogActive = false;
    // The engine runs in a child process, most of this daemon's RSS; a dead child only loses its own searches.
    const iq = createEngineClient({
        root: workspaceRoot,
        indexDir: statePath(workspaceRoot, ".intentic/local/cache/", "iq"),
        // A service: a dead engine costs a re-sweep, and it holds more memory than anything else the daemon runs.
        onSpawn: (pid) => void applyWorkload(pid, { class: "service" }),
        // An index pass failing after warm() has no caller to reject; without this it silently stops tracking disk.
        onIndexError: (error) => logger.warn({ err: error }, "iq index pass failed, search results may be stale"),
        onIndexProgress: (remaining) => {
            if (remaining === 0) {
                if (backlogActive) {
                    backlogActive = false;
                    logger.info("iq index embeddings complete: semantic search at full coverage");
                }
                return;
            }
            const now = Date.now();
            if (backlogActive && now - backlogLoggedAt < BACKLOG_LOG_MS) {
                return;
            }
            backlogActive = true;
            backlogLoggedAt = now;
            logger.info({ remaining }, "iq index building embeddings: semantic search fills in as it goes");
        },
        // The query worker owns the semantic scan and cross-encoder; losing it narrows a search to keyword matching.
        onQueryError: (error) => logger.warn({ err: error }, "iq query worker failed, search fell back to keyword matching"),
        // Well clear of the working set: the child holds the index and the ML models, and was measured at 1.64 GB
        // having grown from 691 MB in half an hour. The point is to bound memory that is not coming back, not to
        // ration what the engine legitimately needs — a ceiling low enough to fire in normal use announces itself
        // in the log below, which is the signal to raise it rather than to keep paying for re-sweeps.
        memoryCeilingBytes: IQ_MEMORY_CEILING_BYTES,
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
