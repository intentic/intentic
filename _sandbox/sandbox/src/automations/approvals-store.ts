import { randomUUID } from "node:crypto";
import { type AutomationApproval, AutomationApprovalSchema } from "@intentic/sandbox-contract";
import { jsonDir } from "../store/json-dir.js";

// The automation approvals queue (<workspace>/.intentic/approvals/<id>.json, one file per held wake): a
// `requireApproval` automation enqueues here instead of waking; the owner approves/rejects via the /automations
// routes. Per-file — never a shared manifest — because concurrent fires from different automations would race a
// read-modify-write (see json-dir.ts, which owns that cycle). The item snapshots the trigger payload so an
// approved run replays exactly what fired, even across a daemon restart. The daemon mints the id; no secrets
// live here.

// The id is the FILENAME, so it is not in the body — the store grafts it back on read.
const ApprovalBodySchema = AutomationApprovalSchema.omit({ id: true });

export interface ApprovalsStore {
    // Held wakes, oldest first (createdAt ascending).
    readonly list: () => Promise<AutomationApproval[]>;
    readonly get: (id: string) => Promise<AutomationApproval | undefined>;
    // Enqueue a held wake, minting its id; returns the stored record.
    readonly add: (approval: Omit<AutomationApproval, "id">) => Promise<AutomationApproval>;
    // True when an approval of that id existed and was removed.
    readonly remove: (id: string) => Promise<boolean>;
}

// A per-file JSON store, used in production at <workspace>/.intentic/approvals/.
export const fileApprovalsStore = (dir: string): ApprovalsStore => {
    const files = jsonDir(dir, (raw) => ApprovalBodySchema.safeParse(raw).data);
    return {
        // A held wake whose file no longer parses is dropped rather than reported: unlike drafts, nothing
        // outside this daemon writes here, so an unreadable one is a bug to fix and not a typo to surface.
        list: async () => (await files.list()).entries.toSorted((a, b) => a.createdAt - b.createdAt),
        get: files.read,
        add: async (approval) => {
            const id = randomUUID();
            await files.write(id, approval);
            return { ...approval, id };
        },
        remove: files.remove,
    };
};
