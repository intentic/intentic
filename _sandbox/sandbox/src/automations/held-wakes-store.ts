import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { type AutomationApproval, AutomationApprovalSchema } from "@intentic/sandbox-contract/schemas/automations";
import { errorMessage } from "@intentic/base/errors";
import { z } from "zod";
import { decisionStanding, fieldsDigest, forgetApprovals, recordDecision } from "../approvals/approval-decisions.js";
import { publishRuntimeChange } from "../seams/runtime-feed.js";
import { defineDocument } from "../store/evolution/documents.js";
import { openDirectory } from "../store/open-document.js";
import { keptKey } from "../auth/signed-payload.js";
import { loadOrMintKey } from "../store/plain-files/minted-key.js";
import { defineStep } from "../store/evolution/state-steps.js";
import { stateRelPath } from "../state-paths.js";

// Held-wakes queue (<history>/automation-holds/<id>.json, one file per wake): a requireApproval automation enqueues here
// instead of firing, and the owner approves or rejects through the /automations routes. Distinct from the approvals
// store: daemon-minted, consumed on release, and snapshots the payload so an approved run replays exactly what fired.
//
// It is kept where the approvals queue's yes is (approvals/approval-decisions.ts), off the workspace every turn writes. A
// hold used to sit under .intentic/records/approvals/, where a file an agent wrote was a hold like any other: with an
// `autoRunAt` in the past the scheduler's countdown scan released it by itself, with the guard and the approval both marked
// cleared. Now:
// - the owner's release is a decision recorded against the digest of the hold it covers, and a hold is released only when
//   that yes stands for the hold as it is, spent on the way out so one yes runs once;
// - a countdown (`autoRunAt`) is honoured only on a hold the daemon minted: the daemon signs what it queued under a key it
//   keeps beside the queue, and a hold whose signature does not verify reads as one that waits for a person;
// - a file this build cannot read stays in the queue's report instead of dropping out of it.
// A hold is only ever handed to a run as a ReleasedWake, which these two doors alone can make.

// Id is the filename, not part of the body; the store grafts it back on read. `mint` is the daemon's signature over the
// rest, present on a countdown hold only and never on the wire.
const HoldBodySchema = AutomationApprovalSchema.omit({ id: true }).extend({ mint: z.string().optional() });

export const heldWakesDocument = defineDocument({ root: "history", path: "automation-holds/", directory: true, schema: HoldBodySchema });

declare const releasedBy: unique symbol;

// A hold that left the queue through a door that checked its proof: the owner's yes, or the daemon's own countdown. The
// only thing a held wake's run accepts, so no path to a run skips the check.
export type ReleasedWake = AutomationApproval & { readonly [releasedBy]: "owner" | "countdown" };

// SAFETY: the brand is a promise only the two releases below make, each after checking its proof; it exists at the type level alone.
const released = (hold: AutomationApproval): ReleasedWake => hold as ReleasedWake;

export interface HeldWakes {
    // Held wakes, oldest first (createdAt ascending). A countdown reads as one only where the daemon minted it.
    readonly wakes: AutomationApproval[];
    // Files in the queue this build cannot read, by name: reported, so a hold that would never run says why.
    readonly unreadable: string[];
}

export interface HeldWakesStore {
    readonly read: () => Promise<HeldWakes>;
    // The readable ones, oldest first.
    readonly list: () => Promise<AutomationApproval[]>;
    // Throws ManifestUnreadableError for a hold that exists but this build cannot read.
    readonly get: (id: string) => Promise<AutomationApproval | undefined>;
    // Enqueue a held wake, minting its id (and, for a countdown, its signature); returns the stored record.
    readonly add: (approval: Omit<AutomationApproval, "id">) => Promise<AutomationApproval>;
    // A rejection: the hold goes unrun. True when one of that id existed and was removed.
    readonly remove: (id: string) => Promise<boolean>;
    // The owner's yes, recorded against the hold as it stands (approvals/approval-decisions.ts, beside the approvals queue's):
    // false when no such hold is left. Only a route that has checked a person gave it may call this.
    readonly approve: (id: string, by: string | undefined) => Promise<boolean>;
    // Lets the hold out of the queue, and only while the owner's yes stands for it as it is now, spending that yes on the way
    // out so one yes runs once. Undefined when no such hold is left (another release took it); throws HeldWakeNotApproved
    // when no yes stands for it, and when it cannot be read.
    readonly release: (id: string) => Promise<ReleasedWake | undefined>;
    // The daemon's own release of a countdown it minted, once its time has come. Undefined for a hold that is gone, is not
    // a countdown the daemon minted, or is not due yet.
    readonly releaseCountdown: (id: string, now: number) => Promise<ReleasedWake | undefined>;
}

export class HeldWakeNotApproved extends Error {
    constructor(id: string, standing: string) {
        super(`the held wake ${id} is not released: the owner's yes for it ${standing === "unreadable" ? "cannot be read" : "does not stand for it as it is now"}`);
        this.name = "HeldWakeNotApproved";
    }
}

// The yes for a hold, in the ledger it shares with the approvals queue: a different key for the same ledger, so an item and
// a hold can never answer for each other.
const decisionKey = (id: string): string => `wake:${id}`;

// What the hold will do, as one digest: every field but its id and the daemon's signature.
const digestOf = (hold: AutomationApproval): string => fieldsDigest(hold, new Set(["id", "mint"]));

const signatureOf = (key: Buffer, hold: AutomationApproval): string => createHmac("sha256", key).update(`automation-hold:${hold.id}:${digestOf(hold)}`).digest("hex");

// A per-file JSON store, used in production at <history>/automation-holds/. `warn` hears a signing key that cannot be read:
// no countdown is honoured then, which is the stricter side, and the queue still lists.
export const fileHeldWakesStore = (historyRoot: string, warn: (message: string, reason: string) => void = () => undefined): HeldWakesStore => {
    const files = openDirectory(heldWakesDocument, join(historyRoot, heldWakesDocument.path));
    // The key a countdown hold's signature is made under, minted on first use and kept beside the queue it guards.
    const key = keptKey(() => loadOrMintKey(join(historyRoot, "automation-holds.key")));

    // What the daemon's signature on this hold would be, or undefined while the key cannot be read: nothing is then signed or
    // honoured, which is the stricter side.
    const signedBy = async (hold: AutomationApproval): Promise<string | undefined> => {
        try {
            return signatureOf(await key(), hold);
        } catch (error) {
            warn("held wakes: the key that signs a countdown could not be read, so every countdown waits for a person until it can", errorMessage(error));
            return undefined;
        }
    };

    // A hold as the rest of the daemon sees it: no signature, and no countdown unless the signature on it verifies.
    const honest = async ({ mint, ...hold }: AutomationApproval & { readonly mint?: string | undefined }): Promise<AutomationApproval> => {
        if (hold.autoRunAt === undefined) {
            return hold;
        }
        const { autoRunAt: _unsigned, ...waitsForAPerson } = hold;
        const expected = await signedBy(hold);
        const given = Buffer.from(mint ?? "");
        return expected !== undefined && given.length === expected.length && timingSafeEqual(given, Buffer.from(expected)) ? hold : waitsForAPerson;
    };

    // Takes the hold out of the queue and spends the yes that went with it. Whether this call is the one that took it: a
    // second release of the same hold, or the countdown beside an approval, finds it gone and runs nothing.
    const take = async (id: string): Promise<boolean> => {
        const taken = await files.remove(id);
        // Spent whether or not this call took it: a yes for a hold that is gone covers nothing.
        await forgetApprovals(historyRoot, [decisionKey(id)]);
        if (taken) {
            publishRuntimeChange("approvals");
        }
        return taken;
    };

    const read = async (): Promise<HeldWakes> => {
        const { entries, invalid } = await files.list();
        const wakes = await Promise.all(entries.map(honest));
        return { wakes: wakes.toSorted((left, right) => left.createdAt - right.createdAt), unreadable: invalid.toSorted() };
    };

    return {
        read,
        list: async () => (await read()).wakes,
        get: async (id) => {
            const hold = await files.read(id);
            return hold === undefined ? undefined : honest(hold);
        },
        add: async (approval) => {
            const id = randomUUID();
            const hold: AutomationApproval = { ...approval, id };
            const mint = approval.autoRunAt === undefined ? undefined : await signedBy(hold);
            await files.write(id, mint === undefined ? approval : { ...approval, mint });
            publishRuntimeChange("approvals");
            return hold;
        },
        remove: async (id) => {
            const removed = await files.remove(id);
            await forgetApprovals(historyRoot, [decisionKey(id)]);
            if (removed) {
                publishRuntimeChange("approvals");
            }
            return removed;
        },
        approve: async (id, by) => {
            const found = await files.read(id);
            if (found === undefined) {
                return false;
            }
            await recordDecision(historyRoot, decisionKey(id), digestOf(await honest(found)), by);
            return true;
        },
        release: async (id) => {
            const found = await files.read(id);
            if (found === undefined) {
                await forgetApprovals(historyRoot, [decisionKey(id)]);
                return undefined;
            }
            const hold = await honest(found);
            // What leaves is judged against the yes as the ledger holds it now, not against anything seen earlier.
            const standing = await decisionStanding(historyRoot, decisionKey(id), digestOf(hold));
            if (standing !== "approved") {
                throw new HeldWakeNotApproved(id, standing);
            }
            return (await take(id)) ? released(hold) : undefined;
        },
        releaseCountdown: async (id, now) => {
            const found = await files.read(id);
            const hold = found === undefined ? undefined : await honest(found);
            if (hold?.autoRunAt === undefined || hold.autoRunAt > now) {
                return undefined;
            }
            return (await take(id)) ? released(hold) : undefined;
        },
    };
};

// The queue as releases before 2026-10-12 kept it, in the workspace, where a turn writes as freely as the daemon.
const LEGACY_DIR = stateRelPath(".intentic/records/approvals/");
// Not a hold: the queue lists `.json` files only, so this marks a directory that was started empty.
const MOVED_MARK = ".moved-from-workspace";

// Brings the queue to the history volume. Every file is carried as it is, readable or not, so a hold is never lost and one
// this build cannot read is reported rather than dropped; the workspace copies are removed, since a copy left behind would
// be a hold released twice by a rollback to a build that still read it (the update's journal keeps them until it commits).
// A hold that was waiting out a countdown arrives waiting for a person: nothing signed it, and one an agent planted looks
// the same. One-shot: the queue's directory existing is what says this ran, so a file written at the old address later is
// never brought over.
export const heldWakesOffWorkspaceStep = defineStep({
    id: "held-wakes-off-workspace",
    describe: "moves the held-wakes queue from the workspace to the history volume",
    plan: async ({ roots, kind, list, read }) => {
        const target = join(roots.history, heldWakesDocument.path);
        if ((await kind(target)) !== undefined) {
            return undefined;
        }
        const legacy = join(roots.workspace, LEGACY_DIR);
        const names = (await kind(legacy)) === "directory" ? (await list(legacy)).filter((name) => name.endsWith(".json")) : [];
        const writes = new Map<string, string | undefined>();
        for (const name of names) {
            const text = await read(join(legacy, name));
            if (text !== undefined) {
                writes.set(join(target, name), text);
                writes.set(join(legacy, name), undefined);
            }
        }
        const moved = writes.size / 2;
        // An empty queue still starts its directory, which is what marks the move as done.
        if (moved === 0) {
            writes.set(join(target, MOVED_MARK), "");
        }
        return {
            changes: [moved === 0 ? `starts ${heldWakesDocument.path} on the history volume with nothing held` : `moves ${moved} held wake(s) from ${LEGACY_DIR} to ${heldWakesDocument.path} on the history volume`],
            writes,
        };
    },
});
