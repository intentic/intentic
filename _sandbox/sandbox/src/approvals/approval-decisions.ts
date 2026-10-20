import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { insideRel } from "@intentic/base/contained";
import { errnoCode } from "@intentic/base/errors";
import type { ApprovalSummary } from "@intentic/sandbox-contract/schemas/approvals";
import type { AutomationApproval } from "@intentic/sandbox-contract/schemas/automations";
import { z } from "zod";
import { defineDocument } from "../store/evolution/documents.js";
import { openApprovalLedger } from "../store/open-document.js";

/* The owner's yes to each item in the approvals queue, pinned by a digest of what the item will do. The queue is a
 * workspace directory every turn writes, so an item's own `status` cannot be what lets it run: a turn could write
 * `approved` itself, or change an approved item before it comes due. The yes lives on the history volume instead,
 * written only by the owner's approve route and spent by the executor as it starts acting, so one yes runs once. A
 * ledger this build cannot read approves nothing. */

const LedgerSchema = z.object({
    approved: z.record(z.string(), z.object({ digest: z.string(), approvedAt: z.number(), approver: z.string().optional() })),
});

export const approvalDecisionsDocument = defineDocument({
    root: "history",
    path: "approval-decisions.json",
    // The owner's yes to each item in the approvals queue, pinned to what it will do: the queue travels with /work, and
    // an item that arrives approved without its yes is not carried out until the target's owner gives it again.
    portability: "identity",
    note: "Approve again from Approvals anything that was approved and had not run yet.",
    schema: LedgerSchema,
});

export interface ApprovalRoots {
    readonly historyRoot: string;
    // Where an item's media paths are read from, as the turn that posts them reads them.
    readonly workspaceRoot: string;
}

// Keyed by the item's id; the pin carries the digest, since an item approved, edited and approved again keeps its id.
const ledgerOf = (historyRoot: string) => openApprovalLedger(approvalDecisionsDocument, join(historyRoot, approvalDecisionsDocument.path));

// The queue's own bookkeeping, which the executor and the turn carrying an item out write as they go. Everything else
// in an item is what gets done, so a field the executor learns to act on later is covered without being listed here.
const BOOKKEEPING: ReadonlySet<string> = new Set(["id", "status", "createdAt", "startedAt", "finishedAt", "result", "error"]);

// A media file as its bytes, since a post attaches whatever the path holds when it runs: a picture swapped after the
// yes is a change like an edited word. Only a regular file inside the workspace is read, and opened without blocking,
// so a path an agent wrote can neither lead outside nor park the daemon on a pipe. A file that cannot be read is
// pinned as that state, which the same file still unreadable later matches and anything else does not.
const mediaFingerprint = async (workspaceRoot: string, path: string): Promise<string> => {
    const full = resolve(workspaceRoot, path);
    if ((insideRel(workspaceRoot, full) ?? "") === "") {
        return "outside the workspace";
    }
    const handle = await open(full, constants.O_RDONLY | constants.O_NONBLOCK).catch((error: unknown) => {
        const code = errnoCode(error);
        if (code === undefined) {
            throw error;
        }
        return code;
    });
    if (typeof handle === "string") {
        return `unreadable (${handle})`;
    }
    try {
        if (!(await handle.stat()).isFile()) {
            return "not a file";
        }
        const hash = createHash("sha256");
        for await (const chunk of handle.createReadStream({ autoClose: false })) {
            hash.update(chunk as Buffer);
        }
        return hash.digest("hex");
    } finally {
        await handle.close();
    }
};

// What a thing will do, as one digest: its fields but the ones named in `skip`, keys sorted and absent ones dropped (an
// undefined key is an absent one once written), and any media file's bytes in the order they are listed. One spelling for
// every kind of yes that pins itself to what it covers, so two kinds cannot disagree about what "changed" means.
export const fieldsDigest = (item: ApprovalSummary | AutomationApproval, skip: ReadonlySet<string>, media: readonly string[] = []): string => {
    const fields = Object.entries(item)
        .filter(([key, value]) => !skip.has(key) && value !== undefined)
        .toSorted(([left], [right]) => (left < right ? -1 : 1));
    return createHash("sha256").update(JSON.stringify({ fields, media })).digest("hex");
};

// What the item will do, as one digest: its fields but the bookkeeping, keys sorted and absent ones dropped, and each
// media file's bytes in the order the post lists them.
export const approvalDigest = async (workspaceRoot: string, item: ApprovalSummary): Promise<string> =>
    fieldsDigest(item, BOOKKEEPING, item.kind === "post" ? await Promise.all((item.media ?? []).map((path) => mediaFingerprint(workspaceRoot, path))) : []);

// Pins the owner's yes to `key` as it stands, whatever kind of thing the key names (an item in the queue by its id, a held
// wake by `wake:<id>`). Written only by a route that has already checked a person gave it.
export const recordDecision = async (historyRoot: string, key: string, digest: string, approver: string | undefined, now = Date.now()): Promise<void> => {
    const pin = { digest, approvedAt: now, ...(approver === undefined ? {} : { approver }) };
    await ledgerOf(historyRoot).update((approved) => ({ ...approved, [key]: pin }));
};

// Pins the owner's yes to the item exactly as it is about to be written. The route records it before writing the
// file, so whoever reads the file as approved already finds its yes.
export const recordApproval = async (roots: ApprovalRoots, item: ApprovalSummary, approver: string | undefined, now = Date.now()): Promise<void> =>
    recordDecision(roots.historyRoot, item.id, await approvalDigest(roots.workspaceRoot, item), approver, now);

// One yes, as it was spent: who gave it and when. A yes given again (a retry) has a later `approvedAt`.
export interface SpentApproval {
    readonly approver: string | undefined;
    readonly approvedAt: number;
}

// Spends the yes of every item that still matches it, in ONE serialized read-change-write of the ledger, and answers the
// ones this call spent. A yes is removed only if its digest is the item's as it stands now, so whoever acts on the answer
// acts on exactly what was approved, and two callers racing for one item cannot both get it: the second finds the pin
// gone. An item whose yes is absent or no longer matches is left alone; its standing says why.
export const spendApprovals = async (roots: ApprovalRoots, items: readonly ApprovalSummary[]): Promise<ReadonlyMap<string, SpentApproval>> => {
    const wanted = await Promise.all(items.map(async (item) => ({ id: item.id, digest: await approvalDigest(roots.workspaceRoot, item) })));
    const spent = new Map<string, SpentApproval>();
    await ledgerOf(roots.historyRoot).update((approved) => {
        spent.clear();
        for (const { id, digest } of wanted) {
            const pin = Object.hasOwn(approved, id) ? approved[id] : undefined;
            if (pin?.digest === digest) {
                spent.set(id, { approver: pin.approver, approvedAt: pin.approvedAt });
            }
        }
        return spent.size === 0 ? approved : Object.fromEntries(Object.entries(approved).filter(([id]) => !spent.has(id)));
    });
    return spent;
};

// Drops the yes for these keys: a rejection, an item put back in review, or whoever acts on it spending it as it starts.
export const forgetApprovals = async (historyRoot: string, ids: readonly string[]): Promise<void> => {
    await ledgerOf(historyRoot).update((approved) => {
        if (!ids.some((id) => Object.hasOwn(approved, id))) {
            return approved;
        }
        return Object.fromEntries(Object.entries(approved).filter(([id]) => !ids.includes(id)));
    });
};

// Where a thing marked approved stands against the ledger: approved as it is now, never approved, changed since its
// yes, or not knowable because the ledger cannot be read.
export type ApprovalStanding = "approved" | "unapproved" | "changed" | "unreadable";

// One read of the ledger, then a standing per item.
export const approvalStandings = async (roots: ApprovalRoots): Promise<(item: ApprovalSummary) => Promise<ApprovalStanding>> => {
    const { approved, unreadable } = await ledgerOf(roots.historyRoot).read();
    return async (item) => {
        if (unreadable) {
            return "unreadable";
        }
        if (!Object.hasOwn(approved, item.id)) {
            return "unapproved";
        }
        return approved[item.id]?.digest === (await approvalDigest(roots.workspaceRoot, item)) ? "approved" : "changed";
    };
};

// The standing of one key against the digest of what it covers now: the same three answers, for a yes that is not an item
// in the queue.
export const decisionStanding = async (historyRoot: string, key: string, digest: string): Promise<ApprovalStanding> => {
    const { approved, unreadable } = await ledgerOf(historyRoot).read();
    if (unreadable) {
        return "unreadable";
    }
    if (!Object.hasOwn(approved, key)) {
        return "unapproved";
    }
    return approved[key]?.digest === digest ? "approved" : "changed";
};
