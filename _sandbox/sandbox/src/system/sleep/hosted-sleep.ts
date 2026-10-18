import { existsSync, rmSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import type { Config } from "../../env.config.js";
import { callIngress } from "../platform-client.js";

// THE HOSTED MACHINE'S ALARM, kept by the platform while it sleeps (api hosted-wake-alarm.ts). A deadline is saved and
// acknowledged before idle-stop stops; an older or unreachable platform cannot keep one, so a machine with something
// due stays awake. Writes are serialized, so a retraction can never overtake the preparation it answers.
// - inherited: until the schedulers and resumers that keep its promises are running, this boot leaves the alarm the
//   last sleep saved as it stands. A boot that stalls and idle-stops before then is woken by that alarm again, rather
//   than having it replaced by a reading taken before the fleet was loaded.
// - owned: `retractAtBoot` takes charge of it; from then on every sleep saves its own.
// The marker file is the daemon's own note that it stopped with an alarm armed: the next boot reads it as the alarm's,
// which is what lets idle-stop sleep again after its short grace when nobody came (sleep/idle-stop.ts).
const SLEEP_ALARM_MARKER = "sleep-alarm";

export interface HostedSleep {
    readonly prepare: (at: number, personAt: number) => Promise<boolean>;
    readonly cancel: (personAt: number) => Promise<boolean>;
    readonly retractAtBoot: () => Promise<boolean>;
    // This boot followed a sleep that armed an alarm, and has taken charge of it.
    readonly alarmBoot: () => boolean;
}

type Save = (at: number | null, personAt: number) => Promise<boolean>;

// Read and removed once, at construction: a boot that fails after this is not an alarm's to grace again.
const consumeMarker = (path: string, logger: Pick<Logger, "warn">): boolean => {
    try {
        const found = existsSync(path);
        rmSync(path, { force: true });
        return found;
    } catch (error) {
        logger.warn({ err: error, path }, "hosted sleep: the alarm marker could not be read; this boot takes the whole window");
        return false;
    }
};

export const createHostedSleep = (
    config: Config,
    logger: Pick<Logger, "warn">,
    save: Save = async (at, personAt) => {
        const answer = await callIngress(config, { route: "wakeAlarm", input: { at, personAt }, signal: AbortSignal.timeout(10_000) });
        return answer.status === 200 && answer.data?.ok === true;
    },
): HostedSleep => {
    const marker = join(config.historyRoot, SLEEP_ALARM_MARKER);
    const followedAlarm = consumeMarker(marker, logger);
    let owned = false;
    const register = async (at: number | null, personAt: number): Promise<boolean> => {
        try {
            const saved = await save(at, personAt);
            if (!saved) {
                logger.warn("hosted sleep: platform did not acknowledge the wake alarm");
            }
            return saved;
        } catch (error) {
            logger.warn({ err: error }, "hosted sleep: could not save the wake alarm");
            return false;
        }
    };
    // A marker that cannot be written only costs the next boot its grace, never the alarm itself.
    const note = async (armed: boolean): Promise<void> => {
        await (armed ? writeFile(marker, "") : rm(marker, { force: true })).catch((error: Error) =>
            logger.warn({ err: error, path: marker }, "hosted sleep: the alarm marker could not be written"),
        );
    };
    let previous: Promise<boolean> = Promise.resolve(true);
    const queue = (at: number | null, personAt: number): Promise<boolean> => {
        const next = previous.then(async () => {
            const saved = await register(at, personAt);
            await note(saved && at !== null);
            return saved;
        });
        previous = next;
        return next;
    };
    return {
        prepare: (at, personAt) => (owned ? queue(at > 0 ? at : null, personAt) : Promise.resolve(true)),
        cancel: (personAt) => (owned ? queue(null, personAt) : Promise.resolve(true)),
        retractAtBoot: () => {
            owned = true;
            return queue(null, 0);
        },
        alarmBoot: () => owned && followedAlarm,
    };
};
