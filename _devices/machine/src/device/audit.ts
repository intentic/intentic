import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { errorMessage } from "@intentic/base/errors";
import { LOG_ROTATE_BYTES } from "@intentic/local-agent";
import { baseDir } from "../config.js";
import { auditPath } from "./config.js";

// Every accepted/refused call, appended as JSON on the machine (not the sandbox), so a user can see what actually ran
// without asking the agent. Best-effort and non-blocking; nothing reads it back to decide anything.

/* HOW BIG THE RECORD MAY GET (2026-10-05). It grew without limit on every machine. Like the agent's log, it is set aside
   as `audit.jsonl.1` once it reaches LOG_ROTATE_BYTES, so the pair is bounded at twice that and the latest calls before
   the roll are still there to read. The writer opens the file by name for every line, so unlike machine.log it can roll
   it itself; the device upkeep (upkeep/retention.ts) rolls it too, for an agent that wrote nothing lately. Both go through
   one queue in this process, so a roll never lands between a size check and the line it was for. */
export const AUDIT_ROLL_BYTES = LOG_ROTATE_BYTES;

let queue: Promise<void> = Promise.resolve();
const inTurn = async <T>(work: () => Promise<T>): Promise<T> => {
    const turn = queue.then(work);
    queue = turn.then(
        () => undefined,
        () => undefined,
    );
    return await turn;
};

// Whether it rolled. A record that is not there is not too big.
const rollNow = async (path: string, limit: number): Promise<boolean> => {
    // allow(silent-catch): a record that is not there yet has nothing to roll
    const size = await stat(path).then(
        (file) => file.size,
        () => 0,
    );
    if (size < limit) {
        return false;
    }
    await rename(path, `${path}.1`);
    return true;
};

export const rollAudit = async (path: string = auditPath, limit: number = AUDIT_ROLL_BYTES): Promise<boolean> => await inTurn(async () => await rollNow(path, limit));

export const audit = async (entry: { tool: string; ok: boolean; detail: string }): Promise<void> => {
    try {
        await inTurn(async () => {
            await mkdir(baseDir, { recursive: true, mode: 0o700 });
            // allow(silent-catch): a record that cannot be rolled is still written to; the size bound waits for the next line
            await rollNow(auditPath, AUDIT_ROLL_BYTES).catch(() => false);
            await appendFile(auditPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { encoding: "utf8", mode: 0o600 });
        });
    } catch (error) {
        // A failed write must not block the call it records, but the gap in the record lands in the agent's log.
        process.stderr.write(`audit: could not record ${entry.tool} in ${auditPath} (${errorMessage(error)})\n`);
    }
};
