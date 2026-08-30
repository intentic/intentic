import { Client } from "pg";
import type { Config } from "./config.js";

// Cross-replica exclusivity for background jobs: a per-run Postgres advisory lock on a fresh,
// single-purpose connection. Session locks release on disconnect, so `end()` in the finally is the
// entire cleanup, a crashed holder frees the lock the moment its connection drops, and no session
// bookkeeping or leader election is needed. One short-lived connection per tick is negligible at the
// jobs' cadences (daily retention, 5-min pool backstop).
//
// Same-session `pg_try_advisory_lock` calls stack rather than conflict, which is why each run gets its
// own connection: two overlapping runs, same process or different replicas, are always two sessions,
// so exactly one acquires the lock and the other skips the tick.

// One stable key per exclusive job.
export const JOB_RETENTION = 1;
// The hosted lane's warm pool reconcile (hosted-pool.ts), two replicas building toward the same target
// would overshoot it every tick. Key 2 belonged to the retired Cloudflare sandbox pool, whose job this is
// the spiritual successor of.
export const JOB_HOSTED_POOL = 2;
// The monthly money cycle, close, then pay. Exclusive for a stronger reason than the others: two replicas
// closing the same month would each write a set of statements, and two payout runs would race for the same
// ones. Money counted twice is not a duplicate log line.
export const JOB_POOL_CYCLE = 3;
// The hosted lane's health watch (hosted-health.ts). Read-only, so the lock is about not paying for the same
// Fly round-trips on every replica, and about one alert rather than one per replica.
export const JOB_HOSTED_HEALTH = 4;
// The hosted lane's provisioning canary (hosted-canary.ts). Exclusive for the strongest reason on this list
// after money: every run BUILDS A MACHINE, so two replicas ticking together would spend twice and, worse,
// leave the second one's sandbox behind when the first collected the leftovers out from under it.
export const JOB_HOSTED_CANARY = 5;

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
