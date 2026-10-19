import { createHash } from "node:crypto";
import { join } from "node:path";
import { diffPowerMaps, type ExtensionManifest, powersOf, type PowersDiff } from "@intentic/extension-manifest";
import { z } from "zod";
import { publishRuntimeChange } from "../../seams/runtime-feed.js";
import { defineDocument } from "../../store/evolution/documents.js";
import { openApprovalLedger } from "../../store/open-document.js";
import { invalidateContributions } from "../contributions.js";

/* The owner's yes to each workspace extension, pinned by its id and a digest of the powers it declared then. Kept under
 * the history root: an agent can write the extension's folder, so its approval must sit where no workspace write
 * reaches. Code edited under the same powers keeps the yes; a ledger this build cannot read approves nothing. */

const LedgerSchema = z.object({
    approved: z.record(z.string(), z.object({ digest: z.string(), powers: z.record(z.string(), z.string()), approvedAt: z.number() })),
});

export const extensionApprovalsDocument = defineDocument({ root: "history", path: "extension-approvals.json", schema: LedgerSchema });

// Keyed by extension id; the pin carries the digest, since one id is approved again for new powers.
const ledgerOf = (historyRoot: string) => openApprovalLedger(extensionApprovalsDocument, join(historyRoot, extensionApprovalsDocument.path));

// Over the power KEYS, sorted: a relabelled view keeps its approval, a newly declared power does not.
const digestOf = (powers: ReadonlyMap<string, string>): string => createHash("sha256").update(JSON.stringify([...powers.keys()].toSorted())).digest("hex");

export const powersDigest = (manifest: ExtensionManifest): string => digestOf(powersOf(manifest));

export interface ExtensionApproval {
    // Approved for exactly the powers it declares now; only then does anything of it run.
    readonly approved: boolean;
    readonly digest: string;
    // What saying yes allows, against the powers approved before when there were any.
    readonly powers: PowersDiff;
    readonly approvedBefore: boolean;
}

// One read of the ledger, then a verdict per extension; an enumeration judges every workspace extension against it.
export const extensionApprovals = async (historyRoot: string): Promise<(id: string, manifest: ExtensionManifest) => ExtensionApproval> => {
    const { approved } = await ledgerOf(historyRoot).read();
    return (id, manifest) => {
        const pin = approved[id];
        const powers = powersOf(manifest);
        const digest = digestOf(powers);
        return {
            approved: pin?.digest === digest,
            digest,
            powers: diffPowerMaps(new Map(Object.entries(pin?.powers ?? {})), powers),
            approvedBefore: pin !== undefined,
        };
    };
};

export const approveExtension = async (historyRoot: string, id: string, manifest: ExtensionManifest, now = Date.now()): Promise<void> => {
    const powers = powersOf(manifest);
    const pin = { digest: digestOf(powers), powers: Object.fromEntries(powers), approvedAt: now };
    try {
        await ledgerOf(historyRoot).update((approved) => ({ ...approved, [id]: pin }));
    } finally {
        // The ledger lives on the history root, which no watcher reads: only its writers can move the cached inventory.
        invalidateContributions();
    }
    // It now stands among the yeses the owner can take back (needs/standing-grants.ts).
    publishRuntimeChange("grants");
};

// A removed extension written again later asks again, whatever it declares.
export const forgetExtensionApproval = async (historyRoot: string, id: string): Promise<void> => {
    try {
        await ledgerOf(historyRoot).update((approved) => {
            if (!(id in approved)) {
                return approved;
            }
            const { [id]: _forgotten, ...rest } = approved;
            return rest;
        });
    } finally {
        invalidateContributions();
    }
    publishRuntimeChange("grants");
};

// The extensions the owner approved and that still stand, newest first, for the list where a yes is taken back (the Access
// tab's Sandbox-wide permissions): each with the powers it was approved for, in the sentences the approval card showed. An
// unreadable ledger approves nothing, so it reads as no extensions, and `unreadable` says why.
export const approvedExtensions = async (
    historyRoot: string,
): Promise<{ readonly extensions: readonly { readonly id: string; readonly powers: readonly string[]; readonly approvedAt: number }[]; readonly unreadable: boolean }> => {
    const { approved, unreadable } = await ledgerOf(historyRoot).read();
    const extensions = Object.entries(approved)
        .map(([id, pin]) => ({ id, powers: Object.values(pin.powers), approvedAt: pin.approvedAt }))
        .toSorted((left, right) => right.approvedAt - left.approvedAt);
    return { extensions, unreadable };
};

// Whether there was an approval to take back. The extension's folder is untouched: it goes back to waiting for a yes,
// exactly as it stood before it was approved.
export const revokeExtensionApproval = async (historyRoot: string, id: string): Promise<boolean> => {
    let found = false;
    try {
        await ledgerOf(historyRoot).update((approved) => {
            if (!Object.hasOwn(approved, id)) {
                return approved;
            }
            found = true;
            return Object.fromEntries(Object.entries(approved).filter(([pinned]) => pinned !== id));
        });
    } finally {
        invalidateContributions();
    }
    if (found) {
        publishRuntimeChange("grants");
    }
    return found;
};
