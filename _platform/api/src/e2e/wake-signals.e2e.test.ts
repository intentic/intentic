import { PrismaClient } from "@intentic/prisma";
import { e2eTier } from "@intentic/testing/e2e";
import { waitFor } from "@intentic/testing/bun";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "pg";
import pino from "pino";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { configSchema } from "../config.js";
import { LISTEN_RETRY_FIRST_MS, startWakeSignals, WAKE_CHANNEL, type WakeSignals } from "../sandbox/local-wake/wake-signals.js";

/* A WAKE SAID ON ONE REPLICA, HEARD ON ANOTHER, on real Postgres: two hubs on one database stand for two api replicas,
 * the browser's wake on one and the machine's held ask on the other. The unit suite drives the listener with a stand-in
 * client; this is what only Postgres can say: that `pg_notify` through Prisma reaches a `LISTEN` on a plain `pg`
 * connection, and that a listener whose backend is killed listens again. Hermetic (Docker only). No migrations: a
 * notification touches no table. */
const tier = e2eTier(`wake signals across replicas, through Postgres NOTIFY`, { enabledBy: `INTENTIC_E2E_HERMETIC` });

// The pin the platform's own compose file runs, so the listener meets production's server.
const POSTGRES_IMAGE = `postgres:18.6-alpine3.24`;

const TUNNEL = `abc123def456`;

describe.skipIf(!tier.runs)(tier.title, () => {
    let container: StartedTestContainer | undefined;
    let databaseUrl = ``;
    const prismas: PrismaClient[] = [];
    const hubs: WakeSignals[] = [];

    // One replica: its own Prisma pool and its own listening connection.
    const replica = (): WakeSignals => {
        const config = configSchema.parse({
            database: { url: databaseUrl, poolMax: 2 },
            betterAuth: { secret: `s` },
            secrets: { key: `` },
            webOrigin: `https://app.test`,
        });
        const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl, max: 2 }) });
        prismas.push(prisma);
        const hub = startWakeSignals({ config, prisma, logger: pino({ level: `silent` }) });
        hubs.push(hub);
        return hub;
    };

    // Whether a fresh connection's notification reaches `hub`; asked until it does, since a listener connects on its own.
    const hears = async (hub: WakeSignals): Promise<void> => {
        const probe = `fffffffff${String(hubs.indexOf(hub)).padStart(3, `0`)}`;
        await waitFor(
            async () => {
                const heard = hub.wait([probe], 200);
                const client = new Client({ connectionString: databaseUrl });
                await client.connect();
                await client.query(`SELECT pg_notify($1, $2)`, [WAKE_CHANNEL, probe]);
                await client.end();
                expect(await heard).toBe(`signal`);
            },
            { timeout: 10_000, interval: 100 },
        );
    };

    beforeAll(async () => {
        container = await new GenericContainer(POSTGRES_IMAGE)
            .withEnvironment({ POSTGRES_USER: `app`, POSTGRES_PASSWORD: `app`, POSTGRES_DB: `app`, POSTGRES_INITDB_ARGS: `--no-sync` })
            .withExposedPorts(5432)
            .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
            .start();
        databaseUrl = `postgresql://app:app@${container.getHost()}:${container.getMappedPort(5432)}/app`;
    }, 240_000);

    afterAll(async () => {
        for (const hub of hubs) {
            await hub.stop();
        }
        for (const prisma of prismas) {
            await prisma.$disconnect();
        }
        await container?.stop();
    });

    it(`ends a wait on one replica when another notifies, within milliseconds`, async () => {
        const browserSide = replica();
        const machineSide = replica();
        await hears(machineSide);
        // The browser's replica has its pool connected, as a serving one does: the first notify would pay for that.
        await browserSide.notify(`000000000000`);
        const held = machineSide.wait([TUNNEL], 5000);
        const toldAt = performance.now();
        await browserSide.notify(TUNNEL);
        expect(await held).toBe(`signal`);
        const latencyMs = performance.now() - toldAt;
        // Said on every run, for whoever measures what a wake costs across replicas.
        console.warn(`a wake notified on one replica ended a wait on another ${latencyMs.toFixed(1)} ms later`);
        expect(latencyMs).toBeLessThan(2500);
        expect(machineSide.waiting()).toBe(0);
    });

    it(`listens again once its connection is killed, and its holders look on coming back`, async () => {
        const browserSide = replica();
        const machineSide = replica();
        await hears(machineSide);
        const admin = new Client({ connectionString: databaseUrl });
        await admin.connect();
        // Read first and killed second: in one statement the planner may call pg_terminate_backend before the filter.
        const listeners = await admin.query<{ pid: number }>(`SELECT pid FROM pg_stat_activity WHERE query = $1 AND pid <> pg_backend_pid()`, [
            `LISTEN ${WAKE_CHANNEL}`,
        ]);
        for (const { pid } of listeners.rows) {
            await admin.query(`SELECT pg_terminate_backend($1)`, [pid]);
        }
        await admin.end();
        // Every replica started so far listens on a connection of its own.
        expect(listeners.rows).toHaveLength(hubs.length);
        // A wait made while nobody listens ends when the listener is back, a notification it may have missed or not.
        const heldThroughTheGap = machineSide.wait([TUNNEL], LISTEN_RETRY_FIRST_MS * 10);
        expect(await heldThroughTheGap).toBe(`signal`);
        await hears(machineSide);
        const held = machineSide.wait([TUNNEL], 5000);
        await browserSide.notify(TUNNEL);
        expect(await held).toBe(`signal`);
    });
});
