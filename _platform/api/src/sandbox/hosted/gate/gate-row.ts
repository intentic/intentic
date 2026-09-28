import type { Prisma, PrismaClient } from "@intentic/prisma";
import type { Logger } from "pino";

/* WHAT THE MACHINE'S ROW REMEMBERS ABOUT ITS VERSIONS, as the state gate (state-gate.ts) reads and writes it.
 *
 * Fly holds one config per machine, so the version before a change survives only here: the image the machine ran before
 * its last image change and the overlay recipe it carried (`previousImage`, `previousEnvironmentHash`), which the owner's
 * rollback goes back to; an image applied without its daemon being seen to come up (`unprovenImage`, ON TRIAL), whose
 * next start is judged and goes back to `previousImage` when it fails; and the platform digest the owner went back from
 * (`skippedDigest`), which a restart does not re-apply. The overlay facts beside the image (`image`, `environmentHash`,
 * `baseImage`, `baseDigest`) are written in the same update whenever the image the machine holds changes, so the row
 * never names one version while the machine holds another. */

// The row the gate reads and writes, and the sandbox whose check-ins say a new daemon came up.
export interface HostedGateRecord {
    readonly prisma: PrismaClient;
    readonly hostedMachineId: string;
    readonly sandboxId: string;
}

// What the row says beside an image: the overlay recipe and the base it was built on, or nulls for the stock image.
export interface HostedImageFacts {
    readonly environmentHash: string | null;
    readonly baseImage: string | null;
    readonly baseDigest: string | null;
}
export const STOCK_FACTS: HostedImageFacts = { environmentHash: null, baseImage: null, baseDigest: null };

// One version as the row keeps it: the image, pinned, and the overlay recipe it carries (null for the stock image).
export interface KeptImage {
    readonly image: string;
    readonly environmentHash: string | null;
}

// The versions the row knows of; nothing without a row to read.
export interface KeptVersions {
    // The overlay the row says the machine runs, null for the stock image (whose digest only Fly holds).
    readonly image: string | null;
    readonly environmentHash: string | null;
    readonly previous: KeptImage | undefined;
    readonly unprovenImage: string | null;
}
const NOTHING_KEPT: KeptVersions = { image: null, environmentHash: null, previous: undefined, unprovenImage: null };

// Read before a change touches anything, so a row that cannot be read stops the change with the machine as it was.
export const keptVersionsOf = async (record: HostedGateRecord | undefined): Promise<KeptVersions> => {
    if (record === undefined) {
        return NOTHING_KEPT;
    }
    const row = await record.prisma.hostedMachine.findUnique({
        where: { id: record.hostedMachineId },
        select: { image: true, environmentHash: true, previousImage: true, previousEnvironmentHash: true, unprovenImage: true },
    });
    if (row === null) {
        return NOTHING_KEPT;
    }
    // `?? null`: a row read by an older client, or a test's partial one, lacks the columns, which means "none".
    const previousImage = row.previousImage ?? null;
    return {
        image: row.image ?? null,
        environmentHash: row.environmentHash ?? null,
        previous: previousImage === null ? undefined : { image: previousImage, environmentHash: row.previousEnvironmentHash ?? null },
        unprovenImage: row.unprovenImage ?? null,
    };
};

// The columns for a machine now holding `image` with these facts: the row names an image only for an overlay.
export const imageColumns = (image: string, facts: HostedImageFacts): Prisma.HostedMachineUpdateInput => ({
    image: facts.environmentHash === null ? null : image,
    environmentHash: facts.environmentHash,
    baseImage: facts.baseImage,
    baseDigest: facts.baseDigest,
});

// Writes what a change did. Never throws: the machine has already changed, and a row that says so late is better than a
// change reported as failed. The error line names the machine, since the row may now describe the wrong version.
export const writeKept = async (record: HostedGateRecord | undefined, data: Prisma.HostedMachineUpdateInput, logger: Logger | undefined): Promise<void> => {
    if (record === undefined) {
        return;
    }
    try {
        await record.prisma.hostedMachine.update({ where: { id: record.hostedMachineId }, data });
    } catch (error) {
        logger?.error(
            { err: error, hostedMachineId: record.hostedMachineId, data },
            `hosted image gate: recording the machine's versions failed; its row may name the wrong one`,
        );
    }
};

const lastSeenAtOf = async (record: HostedGateRecord): Promise<Date | null> =>
    (await record.prisma.sandbox.findUnique({ where: { id: record.sandboxId }, select: { lastSeenAt: true } }))?.lastSeenAt ?? null;

/* WHETHER THE SANDBOX HAS CHECKED IN SINCE NOW: the mark is read at once, before the start it is about, and the answer
 * is true once the announce the new daemon makes as it boots has moved `lastSeenAt` past it. A read that fails is not a
 * check-in; the wait's budget decides. */
export const checkInSince = async (record: HostedGateRecord, logger: Logger | undefined): Promise<() => Promise<boolean>> => {
    const mark = await lastSeenAtOf(record).catch((error) => {
        logger?.warn({ err: error, sandboxId: record.sandboxId }, `hosted image gate: the sandbox's last check-in could not be read; any check-in counts`);
        return null;
    });
    return async () => {
        // allow(silent-catch): an unreadable row is one more poll without a check-in; the wait's budget is the verdict
        const seen = await lastSeenAtOf(record).catch(() => null);
        return seen !== null && seen.getTime() > (mark?.getTime() ?? 0);
    };
};
