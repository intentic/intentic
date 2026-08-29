import { appendFile, mkdir } from "node:fs/promises";
import { baseDir } from "../config.js";
import { auditPath } from "./config.js";

/* Every call this agent accepted or refused, appended here as one JSON line.
 *
 * It is on the MACHINE, not in the sandbox, and that is the point: the record of what was done to somebody's
 * computer should live where they can read it without asking the thing that did it. A sandbox-side log answers
 * "what did the agent believe it did"; this answers "what actually ran here", which is the question somebody
 * asks after something surprising happened.
 *
 * Best-effort, never blocking: a full disk or a locked file must not stop the machine from working. It is a
 * record for a human, not a control, nothing reads it back to make a decision. */
export const audit = async (entry: { tool: string; ok: boolean; detail: string }): Promise<void> => {
    try {
        await mkdir(baseDir, { recursive: true, mode: 0o700 });
        await appendFile(auditPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { encoding: "utf8", mode: 0o600 });
    } catch {
        // Deliberately silent, see above.
    }
};
