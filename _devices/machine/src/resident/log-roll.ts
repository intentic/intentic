import { copyFile, stat, truncate } from "node:fs/promises";
import { basename } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import { LOG_ROTATE_BYTES, type Log } from "@intentic/local-agent";

/* machine.log, ROLLED WHILE THE AGENT RUNS (2026-10-11). It was set aside as machine.log.1 only when the agent started,
   so an agent that stayed up for weeks grew it without bound (31 MB on one machine). The agent cannot rename it from
   inside: its supervisor opened the file and holds it (systemd's `append:`, launchd, the Windows launcher, a distro's
   `>>`), so on POSIX a rename leaves every line going into the .1, and on Windows renaming an open file fails. Every one
   of those writers opened it for appending, though, so the file is copied aside and then cut to nothing in place: their
   next line lands at the new end. A line written between the copy and the cut is lost, which a roll once per 8 MB can
   afford. */

// How often the size is looked at: cheap (one stat), and 8 MB takes far longer than this to write.
export const LOG_ROLL_EVERY_MS = 10 * 60_000;

// Whether it rolled. A log that is not there is not too big.
export const rollOpenLog = async (path: string, limit: number = LOG_ROTATE_BYTES): Promise<boolean> => {
    // allow(silent-catch): no log yet is nothing to roll
    const size = await stat(path).then(
        (file) => file.size,
        () => 0,
    );
    if (size < limit) {
        return false;
    }
    await copyFile(path, `${path}.1`);
    await truncate(path, 0);
    return true;
};

export interface LogRoll {
    readonly stop: () => void;
}

// One look, said only when it rolled or could not.
const rollAndSay = async (path: string, log: Log, everyMs: number): Promise<void> => {
    try {
        if (await rollOpenLog(path)) {
            log(`${basename(path)} reached ${LOG_ROTATE_BYTES / 1024 / 1024} MB; what it held is now ${basename(path)}.1`);
        }
    } catch (error) {
        log(`${basename(path)} could not be rolled (${errorMessage(error)}); trying again in ${everyMs / 60_000} min`);
    }
};

export const startLogRoll = (path: string, log: Log, everyMs: number = LOG_ROLL_EVERY_MS): LogRoll => {
    const timer = setInterval(() => void rollAndSay(path, log, everyMs), everyMs);
    timer.unref();
    return { stop: () => clearInterval(timer) };
};
