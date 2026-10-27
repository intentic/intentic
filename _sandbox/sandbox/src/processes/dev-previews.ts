import {
    idleRecords,
    overCap,
    PREVIEW_CAP,
    PREVIEW_IDLE_MS,
    previewsDir,
    type PreviewRecord,
    readRecords,
    recordName,
    stopPreview,
} from "@intentic/constants/dev-previews";
import type { Logger } from "pino";
import { anyConnected } from "../ports/established.js";

// THE DAEMON'S HALF OF THE MANAGED DEV PREVIEWS (2026-10-27). A conversation's demo server is started from its own turn
// by the demo's dev script (_site/demo/scripts/dev.mjs), inside that turn's mount namespace, so it serves the
// conversation's worktree and node_modules overlay; the script writes a record of it
// (@intentic/constants/dev-previews) and the server keeps that record current and stops itself once unused. Two things
// only the daemon can do are here:
// - SHIELD: a recorded server is a finished turn's process carrying its conversation's stamp, which the reaper ends two
//   minutes after the turn (system/boot/reaper.ts). Its pid is handed to the reaper as if it were a terminal pane's, so
//   the server and what it started outlive the turn, exactly as a kept background job does under its pane.
// - BACKSTOP: a server whose own idle stop never fired (a wedged event loop, a timer that never ran) is stopped once it
//   is OVERDUE_MS past the idle bound with nobody connected to its port, and the cap is held even if a start raced
//   another past it. Both note the reason beside the record first, so the conversation's next start says why.
// The daemon starting servers itself was weighed and left: it has no way into a conversation's mount namespace between
// turns, and within a turn the turn's own shell is already there.

// How long past PREVIEW_IDLE_MS the daemon waits for a server's own stop before it steps in.
const OVERDUE_MS = 5 * 60_000;
// The reaper asks every minute; the records are read at most this often however often it asks.
const SWEEP_EVERY_MS = 30_000;

export interface PreviewKeeperDeps {
    readonly logger: Pick<Logger, "info" | "warn">;
    readonly dir?: string;
    readonly procRoot?: string;
    readonly now?: () => number;
    // Whether anything holds a connection to any of these ports (a page, its HMR socket, a curl).
    readonly connected?: (ports: readonly number[]) => Promise<boolean>;
    readonly stop?: (dir: string, record: PreviewRecord, reason: string) => Promise<void>;
}

export interface PreviewKeeper {
    // Stops the overdue and the over-cap, then answers the live previews' pids, named for the log as the reaper's
    // pane map names its panes.
    readonly holders: () => Promise<ReadonlyMap<number, string>>;
}

export const createPreviewKeeper = (deps: PreviewKeeperDeps): PreviewKeeper => {
    const dir = deps.dir ?? previewsDir();
    const now = deps.now ?? Date.now;
    const connected = deps.connected ?? ((ports: readonly number[]) => anyConnected(ports));
    const stop = deps.stop ?? stopPreview;
    let sweptAt = Number.NEGATIVE_INFINITY;
    let held: ReadonlyMap<number, string> = new Map();

    const stopNoted = async (record: PreviewRecord, reason: string): Promise<boolean> => {
        try {
            await stop(dir, record, reason);
            deps.logger.info({ conversation: record.conversation, label: record.label, port: record.port, reason }, "previews: stopped a dev preview");
            return true;
        } catch (error) {
            deps.logger.warn({ err: error, conversation: record.conversation }, "previews: a dev preview could not be stopped");
            return false;
        }
    };

    const sweep = async (): Promise<readonly PreviewRecord[]> => {
        const records = readRecords(dir, deps.procRoot);
        const stopped = new Set<PreviewRecord>();
        for (const record of idleRecords(records, now(), PREVIEW_IDLE_MS + OVERDUE_MS)) {
            if (!(await connected([record.port])) && (await stopNoted(record, `idle: unused for over ${String(PREVIEW_IDLE_MS / 60_000)} minutes, and its own idle stop had not ended it`))) {
                stopped.add(record);
            }
        }
        // overCap names what to stop for one more to fit; here nothing is starting, so the bound is one higher.
        for (const record of overCap(records.filter((one) => !stopped.has(one)), PREVIEW_CAP + 1)) {
            if (await stopNoted(record, `cap: more than ${String(PREVIEW_CAP)} were running, and this one was used least recently`)) {
                stopped.add(record);
            }
        }
        return records.filter((record) => !stopped.has(record));
    };

    return {
        holders: async () => {
            if (now() - sweptAt >= SWEEP_EVERY_MS) {
                sweptAt = now();
                try {
                    const live = await sweep();
                    held = new Map(live.map((record) => [record.pid, `preview:${recordName(record.conversation, record.label)}`]));
                } catch (error) {
                    // The last answer stands: a read that failed says nothing about which previews stopped.
                    deps.logger.warn({ err: error }, "previews: the preview records could not be read");
                }
            }
            return held;
        },
    };
};

// The reaper's pane listing with every live preview added as one more pane, so the leftover sweep spares them.
export const withPreviewHolders =
    (panePids: () => Promise<Map<number, string>>, keeper: PreviewKeeper) =>
    async (): Promise<Map<number, string>> =>
        new Map([...(await panePids()), ...(await keeper.holders())]);
