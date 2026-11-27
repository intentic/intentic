import { existsSync, rmSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WakeDoor } from "@intentic/api-contract/ingress";
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
// (2026-11-27) Every sleep also saves its wake doors (wake-doors.ts), the public URLs a request may wake it at, on the
// same write whether or not anything is due; the retraction at boot clears them, since an awake machine is reached down
// its tunnel. The platform's answer to that retraction says whether a request at a door started this boot
// (`requestWake`), which idle-stop graces as it graces the alarm's. A second marker notes that the last stop was a sleep
// (`sleeping`), what an extension's `api.sleep.boot()` reads to undo what its before-sleep hook did.
const SLEEP_ALARM_MARKER = "sleep-alarm";
const SLEPT_MARKER = "slept";

// What this boot follows, as an extension's `api.sleep.boot()` hears it.
export interface SleepBootFacts {
    readonly afterSleep: boolean;
    readonly requestWake: boolean;
}

export interface HostedSleep {
    readonly prepare: (at: number, personAt: number) => Promise<boolean>;
    readonly cancel: (personAt: number) => Promise<boolean>;
    readonly retractAtBoot: () => Promise<boolean>;
    // This boot followed a sleep that armed an alarm, and has taken charge of it.
    readonly alarmBoot: () => boolean;
    // This boot is one the platform started for a request at a wake door, as it said once this boot took charge.
    readonly requestBoot: () => boolean;
    // The machine is about to stop for a sleep: noted for the next boot. Never rejects.
    readonly sleeping: () => Promise<void>;
    // What this boot follows, once the retraction at boot has been answered (or failed).
    readonly bootFacts: () => Promise<SleepBootFacts>;
    // Whether the last stop was a sleep, known from the start.
    readonly afterSleep: boolean;
}

// One alarm write: the deadline (null for none), the last moment a person was here, and the doors to sleep with
// (absent sends none, which leaves the stored list as it stands).
export interface AlarmWrite {
    readonly at: number | null;
    readonly personAt: number;
    readonly doors?: readonly WakeDoor[] | undefined;
}

export interface AlarmSaved {
    readonly saved: boolean;
    readonly requestWake?: boolean | undefined;
}

type Save = (alarm: AlarmWrite) => Promise<AlarmSaved>;
type Doors = () => Promise<readonly WakeDoor[]>;

// Read and removed once, at construction: a boot that fails after this is not an alarm's to grace again.
const consumeMarker = (path: string, logger: Pick<Logger, "warn">): boolean => {
    try {
        const found = existsSync(path);
        rmSync(path, { force: true });
        return found;
    } catch (error) {
        logger.warn({ err: error, path }, "hosted sleep: a sleep marker could not be read; this boot reads as one that followed none");
        return false;
    }
};

const platformSave =
    (config: Config): Save =>
    async ({ at, personAt, doors }) => {
        const input = doors === undefined ? { at, personAt } : { at, personAt, doors: [...doors] };
        const answer = await callIngress(config, { route: "wakeAlarm", input, signal: AbortSignal.timeout(10_000) });
        return { saved: answer.status === 200 && answer.data?.ok === true, requestWake: answer.status === 200 && answer.data?.requestWake === true };
    };

export const createHostedSleep = (config: Config, logger: Pick<Logger, "warn">, save: Save = platformSave(config), doors?: Doors): HostedSleep => {
    const marker = join(config.historyRoot, SLEEP_ALARM_MARKER);
    const slept = join(config.historyRoot, SLEPT_MARKER);
    const followedAlarm = consumeMarker(marker, logger);
    const afterSleep = consumeMarker(slept, logger);
    let owned = false;
    let requestWake = false;
    const charged = Promise.withResolvers<void>();
    const register = async (alarm: AlarmWrite): Promise<AlarmSaved> => {
        try {
            const saved = await save(alarm);
            if (!saved.saved) {
                logger.warn("hosted sleep: platform did not acknowledge the wake alarm");
            }
            return saved;
        } catch (error) {
            logger.warn({ err: error }, "hosted sleep: could not save the wake alarm");
            return { saved: false };
        }
    };
    // A door list that cannot be read costs this sleep its doors (the stored list stands), never the alarm beside it.
    const sleepDoors = async (): Promise<readonly WakeDoor[] | undefined> => {
        try {
            return await doors?.();
        } catch (error) {
            logger.warn({ err: error }, "hosted sleep: the wake doors could not be read; this sleep saves none");
            return undefined;
        }
    };
    // A marker that cannot be written only costs the next boot its grace, never the alarm itself.
    const note = async (armed: boolean): Promise<void> => {
        await (armed ? writeFile(marker, "") : rm(marker, { force: true })).catch((error: Error) =>
            logger.warn({ err: error, path: marker }, "hosted sleep: the alarm marker could not be written"),
        );
    };
    let previous: Promise<boolean> = Promise.resolve(true);
    const queue = (at: number | null, personAt: number, write: () => Promise<readonly WakeDoor[] | undefined>): Promise<boolean> => {
        const next = previous.then(async () => {
            const saved = await register({ at, personAt, doors: await write() });
            await note(saved.saved && at !== null);
            return saved.saved;
        });
        previous = next;
        return next;
    };
    return {
        prepare: (at, personAt) => (owned ? queue(at > 0 ? at : null, personAt, sleepDoors) : Promise.resolve(true)),
        cancel: (personAt) => (owned ? queue(null, personAt, sleepDoors) : Promise.resolve(true)),
        retractAtBoot: () => {
            owned = true;
            const next = previous.then(async () => {
                const saved = await register({ at: null, personAt: 0, doors: [] });
                requestWake = saved.requestWake === true;
                charged.resolve();
                await note(false);
                return saved.saved;
            });
            previous = next;
            return next;
        },
        alarmBoot: () => owned && followedAlarm,
        requestBoot: () => owned && requestWake,
        sleeping: () =>
            writeFile(slept, "").catch((error: Error) => logger.warn({ err: error, path: slept }, "hosted sleep: the sleep marker could not be written")),
        bootFacts: async () => {
            await charged.promise;
            return { afterSleep, requestWake };
        },
        afterSleep,
    };
};
