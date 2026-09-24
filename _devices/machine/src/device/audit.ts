import { appendFile, mkdir } from "node:fs/promises";
import { errorMessage } from "@intentic/base/errors";
import { baseDir } from "../config.js";
import { auditPath } from "./config.js";

// Every accepted/refused call, appended as JSON on the machine (not the sandbox), so a user can see what actually ran
// without asking the agent. Best-effort and non-blocking; nothing reads it back to decide anything.
export const audit = async (entry: { tool: string; ok: boolean; detail: string }): Promise<void> => {
    try {
        await mkdir(baseDir, { recursive: true, mode: 0o700 });
        await appendFile(auditPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { encoding: "utf8", mode: 0o600 });
    } catch (error) {
        // A failed write must not block the call it records, but the gap in the record lands in the agent's log.
        process.stderr.write(`audit: could not record ${entry.tool} in ${auditPath} (${errorMessage(error)})\n`);
    }
};
