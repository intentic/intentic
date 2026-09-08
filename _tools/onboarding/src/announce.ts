import { PrismaClient } from "@intentic/prisma";
import { PrismaPg } from "@prisma/adapter-pg";

// "Connected" means `daemonUrl` is set on the row, the platform's record that a daemon reached it and was accepted, not
// a UI text match (once false-green in 7s). `announceRefusal` turns silent non-arrival into a message. Returns the row
// because the CLI lane needs the daemon's hostname afterward.

export interface AnnouncedSandbox {
    readonly id: string;
    /** The address the daemon announced (`https://sandbox-<id>.<zone>`); the leading label is the slug. */
    readonly daemonUrl: string;
}

export const waitForAnnounce = async (databaseUrl: string, since: Date, timeoutMs: number): Promise<AnnouncedSandbox> => {
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
    const deadline = Date.now() + timeoutMs;
    try {
        let last = `no sandbox row yet`;
        while (Date.now() < deadline) {
            const rows = await prisma.sandbox.findMany({ select: { id: true, lastSeenAt: true, daemonUrl: true, announceRefusal: true } });
            // Checks `lastSeenAt >= since`, not just present; a stale row can carry an address from creation, not this
            // run.
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
