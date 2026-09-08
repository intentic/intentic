import { randomUUID } from "node:crypto";
import { type AutomationApproval, AutomationApprovalSchema } from "@intentic/sandbox-contract";
import { jsonDir } from "../store/json-dir.js";

// Held-wakes queue (<workspace>/.intentic/records/approvals/<id>.json, one file per wake): a requireApproval automation
// enqueues here instead of firing; the owner approves or rejects via the /automations routes. Distinct from the
// approvals store: daemon-minted, consumed on release, and snapshots the payload so an approved run replays exactly
// what fired.

// Id is the filename, not part of the body; the store grafts it back on read.
const ApprovalBodySchema = AutomationApprovalSchema.omit({ id: true });

export interface HeldWakesStore {
    // Held wakes, oldest first (createdAt ascending).
    readonly list: () => Promise<AutomationApproval[]>;
    readonly get: (id: string) => Promise<AutomationApproval | undefined>;
    // Enqueue a held wake, minting its id; returns the stored record.
    readonly add: (approval: Omit<AutomationApproval, "id">) => Promise<AutomationApproval>;
    // True when an approval of that id existed and was removed.
    readonly remove: (id: string) => Promise<boolean>;
}

// A per-file JSON store, used in production at <workspace>/.intentic/records/approvals/.
export const fileHeldWakesStore = (dir: string): HeldWakesStore => {
    const files = jsonDir(dir, (raw) => ApprovalBodySchema.safeParse(raw).data);
    return {
        // A file that fails to parse is dropped, not reported: nothing outside this daemon writes here.
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
