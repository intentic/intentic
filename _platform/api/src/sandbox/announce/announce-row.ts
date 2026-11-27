import { Prisma } from "@intentic/prisma";
import type { CopiesState } from "./announce-copies.js";

/* WHAT AN ACCEPTED ANNOUNCE WRITES ON ITS SANDBOX'S ROW (app.ts, the announce route). Where the daemon answers, which
 * build it is (null for one too old to say, so the row never keeps a stale one), and that it was here now. The refusal
 * record clears, since a stored refusal must describe a live disagreement, and so does the removal tombstone, for the
 * same reason: this sandbox is plainly here, whatever was deleted on some machine before. A box set up again on the
 * same token heals its own record. Two moments are written once and never again: the first announce, and (2026-11-26)
 * the first turn a person started that finished without failing, from the first announce that names one. That one is
 * never dated later than the announce that brought it, so a daemon whose clock runs ahead of ours cannot place an
 * activation in the future, and never moved once written. */

// The row as the announce read it: the two moments, null until written.
export interface AnnouncedRow {
    readonly firstAnnouncedAt: Date | null;
    readonly firstTurnAt: Date | null;
}

// What this announce said and established: the copies are absent for a daemon too old to name which copy it is.
export interface AnnounceHeard {
    readonly daemonUrl: string;
    readonly version: string | null;
    readonly firstTurnAt: number | undefined;
    readonly copies: CopiesState | undefined;
}

export const announcedRow = (row: AnnouncedRow, heard: AnnounceHeard, now: Date): Prisma.SandboxUpdateManyMutationInput => {
    const data: Prisma.SandboxUpdateManyMutationInput = {
        daemonUrl: heard.daemonUrl,
        daemonVersion: heard.version,
        lastSeenAt: now,
        announceRefusal: Prisma.DbNull,
        removedAt: null,
        removedBy: null,
    };
    if (row.firstAnnouncedAt === null) {
        data.firstAnnouncedAt = now;
    }
    if (row.firstTurnAt === null && heard.firstTurnAt !== undefined) {
        data.firstTurnAt = new Date(Math.min(heard.firstTurnAt, now.getTime()));
    }
    if (heard.copies !== undefined) {
        data.seenInstances = [...heard.copies.seen];
        data.duplicateSince = heard.copies.duplicateSince;
    }
    return data;
};
