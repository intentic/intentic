import { PrismaClient } from "@intentic-app/prisma";
import { PrismaPg } from "@prisma/adapter-pg";

/* WHAT "CONNECTED" MEANS, ASKED OF THE PLATFORM ITSELF — the gate every provisioner ends on.
 *
 * The obvious assertion is the wizard's own step 2 advancing, and it was the first thing tried: a regex for
 * "connected" matched `Chat is available once your sandbox is connected.`, copy about the state we were
 * waiting for, and the whole provision went green in seven seconds without a daemon ever having announced. A
 * loose text match on a screen full of sentences about the thing being waited for is a false green waiting to
 * happen.
 *
 * `daemonUrl` on the row is the platform's own record that a daemon reached it and was accepted, which is what
 * "connected" means and is not a phrase anyone can accidentally match. `announceRefusal` is the field that
 * turns "nothing happened" into a sentence: the platform writes the address a daemon claimed when it refuses
 * it.
 *
 * It ANSWERS WITH THE ROW because the sandbox's own address is the only thing a caller has to go on
 * afterwards: the CLI lane reads the container's name out of it (the daemon's hostname is the slug every
 * later command keys off), and the compose lane needs nothing and takes nothing.
 */

export interface AnnouncedSandbox {
    readonly id: string;
    /** The address the daemon announced — `https://sandbox-<id>.<zone>`, whose leading label is the slug. */
    readonly daemonUrl: string;
}

export const waitForAnnounce = async (databaseUrl: string, since: Date, timeoutMs: number): Promise<AnnouncedSandbox> => {
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
    const deadline = Date.now() + timeoutMs;
    try {
        let last = `no sandbox row yet`;
        while (Date.now() < deadline) {
            const rows = await prisma.sandbox.findMany({ select: { id: true, lastSeenAt: true, daemonUrl: true, announceRefusal: true } });
            /* `lastSeenAt` AFTER this run started, not merely present. The announce handler is the only writer
             * of it, but a row can carry an address from the moment it is created, which is how the first
             * version of this wait returned in five seconds, before the container had finished booting. The
             * timestamp is the part no other code path can produce. */
            const announced = rows.find((row) => row.lastSeenAt !== null && row.lastSeenAt >= since);
            if (announced !== undefined) {
                return { id: announced.id, daemonUrl: announced.daemonUrl ?? `` };
            }
            if (rows.length > 0) {
                last = rows
                    .map((row) => `${row.id}: lastSeenAt=${row.lastSeenAt?.toISOString() ?? `never`}, refusal=${JSON.stringify(row.announceRefusal)}`)
                    .join(`; `);
            }
            await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
        }
        throw new Error(`no sandbox announced itself to the platform within ${Math.round(timeoutMs / 1000)}s: ${last}`);
    } finally {
        await prisma.$disconnect();
    }
};
