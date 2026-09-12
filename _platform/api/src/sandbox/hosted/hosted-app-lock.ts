import { Client } from "pg";
import type { Config } from "../../config.js";

// Provision and cleanup cannot write the same app concurrently, including across API replicas.
export const withHostedAppLock = async <T>(config: Config, appName: string, wait: boolean, work: () => Promise<T>): Promise<T | undefined> => {
    const client = new Client({ connectionString: config.database.url });
    await client.connect();
    try {
        if (wait) {
            await client.query(`SELECT pg_advisory_lock(hashtext('hosted-app'), hashtext($1))`, [appName]);
        } else {
            const { rows } = await client.query<{ locked: boolean }>(`SELECT pg_try_advisory_lock(hashtext('hosted-app'), hashtext($1)) AS locked`, [
                appName,
            ]);
            if (!rows[0]?.locked) {
                return undefined;
            }
        }
        return await work();
    } finally {
        await client.end();
    }
};
