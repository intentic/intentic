import { Client } from "pg";
import type { Config } from "./config.js";

// A per-run Postgres advisory lock on a fresh connection; session locks release on disconnect, so `end()` is the whole
// cleanup and a crashed holder frees it immediately. One connection per run since same-session locks stack rather than
// conflict.

export const JOB_RETENTION = 1;
// Two replicas reconciling the warm pool together would overshoot its target.
export const JOB_HOSTED_POOL = 2;
// Read-only; the lock avoids duplicate Fly round-trips and duplicate alerts across replicas.
export const JOB_HOSTED_HEALTH = 4;
// Every run builds a machine: two replicas ticking together would double-spend and orphan a sandbox.
export const JOB_HOSTED_CANARY = 5;
// Charges a build once, force-destroys timed-out builders; concurrent runs would double-bill or race a delete.
export const JOB_HOSTED_BUILD = 6;
// Settles stopped stretches and stops overspent machines; concurrent runs would double-bill a stretch.
export const JOB_HOSTED_METER = 7;

export const runExclusive = async (config: Config, key: number, fn: () => Promise<void>): Promise<void> => {
    const client = new Client({ connectionString: config.database.url });
    await client.connect();
    try {
        const { rows } = await client.query<{ locked: boolean }>(`SELECT pg_try_advisory_lock($1) AS locked`, [key]);
        if (!rows[0]?.locked) {
            return;
        }
        await fn();
    } finally {
        await client.end();
    }
};
