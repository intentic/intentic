import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { GateVerdictSchema } from "@intentic/sandbox-contract";

// The landing gate's last verdict (<workspace>/.intentic/gate.json) — persisted so the Changes panel's badge
// survives a reload and a daemon restart. The tree it describes outlives the process that ran the check, so a
// verdict that died with the daemon would leave the badge silent over a red composite.
//
// `stale` is NOT stored: it is the answer to "does the tree still look like it did", which only the tree can
// answer, and a remembered `false` would be exactly the stale green light this gate exists to prevent. The
// service recomputes it on every read (gate.ts), so the stored shape is the verdict minus that one field.
const StoredVerdictSchema = GateVerdictSchema.omit({ stale: true });
export type StoredVerdict = typeof StoredVerdictSchema._output;

export interface GateStore {
    // undefined until the gate has ever run — the caller renders `idle` for it rather than inventing a verdict.
    readonly read: () => Promise<StoredVerdict | undefined>;
    readonly write: (verdict: StoredVerdict) => Promise<void>;
}

export const fileGateStore = (path: string): GateStore => ({
    read: async () => {
        try {
            const parsed = StoredVerdictSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
            // A verdict this daemon cannot parse is a verdict from a different shape of this file. Dropping it
            // reads as `idle` — the next land re-runs the check — where surfacing a parse error would put a
            // permanent red line over a panel whose tree may be perfectly fine.
            return parsed.success ? parsed.data : undefined;
        } catch {
            return undefined;
        }
    },
    write: async (verdict) => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, `${JSON.stringify(verdict, undefined, 2)}\n`, { mode: 0o600 });
    },
});
