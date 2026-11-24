import { join } from "node:path";
import { parseJsonWith } from "@intentic/base/json";
import { readTextIfExists, writeFileAtomic } from "@intentic/base/fs";
import { z } from "zod";

/* WHICH RUNNERS ARE DOWN ON PURPOSE, so the keeper leaves them down and the board says why: one stopped from the board
   (`board`), one a drain stopped once its job ended (`drain`), and one whose drain still waits for its job (`draining`,
   with `after: "start"` for a restart). The fleet service alone writes the file; it is world-readable (0644), so the
   person's agent reads it even while the service is down. A smoke pause (wsl-workers.sh) is read from the unit itself,
   never written here. */

const HoldEntrySchema = z.object({
    hold: z.enum(["board", "drain"]),
    at: z.string(),
    // A drain waiting for the runner's job to end.
    draining: z.boolean().default(false),
    // What follows the drain's stop: nothing, or a start (a restart).
    after: z.enum(["stay", "start"]).default("stay"),
});

export const HoldsSchema = z.record(z.string(), HoldEntrySchema);
export type Holds = z.infer<typeof HoldsSchema>;

const holdsPath = (stateDir: string): string => join(stateDir, "holds.json");

// The service's own file, read from the disk itself (not through the FleetSys seam, which is the computer's runners and
// programs): a test points `stateDir` at a temp folder.
export const readHolds = async (stateDir: string): Promise<Holds> => {
    const text = await readTextIfExists(holdsPath(stateDir));
    return (text === undefined ? undefined : parseJsonWith(text, HoldsSchema)) ?? {};
};

export const writeHolds = async (stateDir: string, holds: Holds): Promise<void> => {
    await writeFileAtomic(holdsPath(stateDir), `${JSON.stringify(holds, undefined, 2)}\n`, 0o644);
};
