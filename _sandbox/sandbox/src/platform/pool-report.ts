import type { Logger } from "pino";
import type { Config } from "../env.config.js";
import { recentActiveUse, utcDay } from "../extensions/extension-active-use.js";
import { postToPlatform } from "./platform-client.js";

/* THE CREATOR-POOL REPORT — the daemon telling the platform which premium extensions this sandbox actually
 * used, as (extension id, UTC day) rows and nothing else (extensions/extension-active-use.ts is the whole
 * story of what gets recorded and why that little).
 *
 * Cadence, not correctness, is the design here. The platform upserts every row on a unique key, so a report
 * is idempotent and the reporter can be dumb: send the last few days' rows on boot and then every few hours,
 * keep no acks, and let a failed attempt be repaired by the next one. A sandbox that is off for a week sends
 * the tail it still holds when it returns; days older than the report window are the accepted loss, stated
 * here rather than hidden (a machine that stayed off that long earned its creators that little use).
 *
 * Authenticated like every daemon→platform call: possession of the connect token, which the platform resolves
 * to the sandbox's OWNER — whose membership is what makes the days count toward the pool. */

// How much tail each report carries. Comfortably wider than the cadence, so a few failed attempts lose nothing.
const REPORT_DAYS = 7;
// Boot delay: let the boot chain and the announce settle before spending a platform round-trip on ledger rows.
const FIRST_REPORT_MS = 60_000;
// Steady cadence. A day bit can wait hours; what matters is that every day is covered by several attempts.
const EVERY_MS = 6 * 60 * 60_000;

export interface PoolReporter {
    readonly start: () => void;
    readonly stop: () => void;
}

export const createPoolReporter = (config: Config, root: string, logger: Logger, now: () => Date = () => new Date()): PoolReporter => {
    let timer: NodeJS.Timeout | undefined;

    const attempt = async (): Promise<void> => {
        const rows = await recentActiveUse(root, REPORT_DAYS, utcDay(now()));
        if (rows.length === 0) {
            return;
        }
        const response = await postToPlatform(config, "/pool/report", { rows });
        if (response.status < 200 || response.status >= 300) {
            // 404 is a platform with the pool switched off — normal, and not worth a warning every 6 hours.
            const level = response.status === 404 ? "debug" : "warn";
            logger[level](`creator-pool report was not accepted (HTTP ${response.status})`);
            return;
        }
        logger.debug(`creator-pool report sent (${rows.length} extension-day${rows.length === 1 ? "" : "s"})`);
    };

    const tick = (delay: number): void => {
        timer = setTimeout(() => {
            void attempt()
                .catch((error: unknown) => logger.debug(`creator-pool report failed: ${error instanceof Error ? error.message : String(error)}`))
                .finally(() => tick(EVERY_MS));
        }, delay);
        // A pending report must never hold the process open — the same courtesy every other daemon timer pays.
        timer.unref();
    };

    return {
        start: () => {
            if (timer === undefined) {
                tick(FIRST_REPORT_MS);
            }
        },
        stop: () => {
            if (timer !== undefined) {
                clearTimeout(timer);
                timer = undefined;
            }
        },
    };
};
