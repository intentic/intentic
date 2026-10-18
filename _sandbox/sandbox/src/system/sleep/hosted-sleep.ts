import type { Logger } from "pino";
import type { Config } from "../../env.config.js";
import { callIngress } from "../platform-client.js";

// An acknowledgement is a prerequisite for idle-stop, not a best-effort report. An older or unreachable platform
// cannot keep an alarm, so this daemon remains awake. Serialize boot's cancellation with any later sleep preparation.
export const createHostedSleep = (
    config: Config,
    logger: Pick<Logger, "warn">,
    save: (at: number | null) => Promise<boolean> = async (at) => {
        const answer = await callIngress(config, { route: "wakeAlarm", input: { at }, signal: AbortSignal.timeout(10_000) });
        return answer.status === 200 && answer.data?.ok === true;
    },
) => {
    const register = async (at: number | null): Promise<boolean> => {
        try {
            const saved = await save(at);
            if (!saved) { logger.warn("hosted sleep: platform did not acknowledge the wake alarm; staying awake"); }
            return saved;
        } catch (error) {
            logger.warn({ err: error }, "hosted sleep: could not save the wake alarm; staying awake");
            return false;
        }
    };
    let previous = register(null);
    const queue = (at: number | null): Promise<boolean> => {
        const next = previous.then(() => register(at));
        previous = next;
        return next;
    };
    return { prepare: (at: number) => queue(at > 0 ? at : null), cancel: () => queue(null) };
};
