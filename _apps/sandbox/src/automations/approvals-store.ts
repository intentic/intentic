import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type AutomationApproval, AutomationApprovalSchema } from "@intentic/sandbox-contract";

// The automation approvals queue (<workspace>/.intentic/approvals/<id>.json, one file per held wake): a
// `requireApproval` automation enqueues here instead of waking; the owner approves/rejects via the /automations
// routes. Per-file — never a shared manifest — because concurrent fires from different automations would race a
// read-modify-write. The item snapshots the trigger payload so an approved run replays exactly what fired, even
// across a daemon restart. The daemon mints the id; no secrets live here.

// Same charset as the contract's entryId — a filename that doesn't match is ignored, never trusted.
const FILE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,59}$/;

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
    const read = async (id: string): Promise<AutomationApproval | undefined> => {
        try {
            const parsed = AutomationApprovalSchema.safeParse({ ...JSON.parse(await readFile(join(dir, `${id}.json`), "utf8")), id });
            return parsed.success ? parsed.data : undefined;
        } catch {
            return undefined;
        }
    };
    return {
        list: async () => {
            let names: string[];
            try {
                names = await readdir(dir);
            } catch {
                return [];
            }
            const approvals: AutomationApproval[] = [];
            for (const file of names.filter((name) => name.endsWith(".json"))) {
                const id = file.slice(0, -".json".length);
                if (!FILE_ID.test(id)) {
                    continue;
                }
                const approval = await read(id);
                if (approval !== undefined) {
                    approvals.push(approval);
                }
            }
            return approvals.toSorted((a, b) => a.createdAt - b.createdAt);
        },
        get: read,
        add: async (approval) => {
            const stored: AutomationApproval = { ...approval, id: randomUUID() };
            await mkdir(dir, { recursive: true });
            const { id, ...body } = stored;
            await writeFile(join(dir, `${id}.json`), `${JSON.stringify(body, undefined, 2)}\n`);
            return stored;
        },
        remove: async (id) => {
            try {
                await unlink(join(dir, `${id}.json`));
                return true;
            } catch {
                return false;
            }
        },
    };
};
