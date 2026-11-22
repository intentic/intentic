import { stat } from "node:fs/promises";
import { errorMessage } from "@intentic/base/errors";
import type { HostPower } from "@intentic/sandbox-contract/schemas/host-power";
import { thisSide } from "../environments/wsl.js";
import { powerChangedPath } from "./apply.js";
import { type LinuxPowerReading, linuxFindings, readLinuxPower } from "./linux.js";
import { type MacPowerReading, macFindings, readMacPower } from "./macos.js";
import { windowsFindings } from "./windows-findings.js";
import { readWindowsPower, type WindowsPowerReading } from "./windows-reading.js";

/* WHICH ENVIRONMENT SAYS WHAT THE COMPUTER'S OWN POWER SETTINGS DO (2026-11-22), and the reading the device's facts
   carry (`DeviceFacts.power`). Only the environment that owns the settings reads them: Windows' own side, a Linux
   host, a Mac. A WSL distro never does: its computer is the Windows PC around it, whose own agent says it, and a
   distro saying it too would have one PC reported twice. */

export type PowerHere =
    | { readonly kind: "windows"; readonly reading: WindowsPowerReading; readonly power: HostPower }
    | { readonly kind: "linux"; readonly reading: LinuxPowerReading; readonly power: HostPower }
    | { readonly kind: "macos"; readonly reading: MacPowerReading; readonly power: HostPower }
    // A WSL distro: the settings are the Windows side's.
    | { readonly kind: "wsl" }
    | { readonly kind: "other"; readonly platform: string };

export const readPowerHere = async (): Promise<PowerHere> => {
    const side = await thisSide();
    if (side === "windows") {
        const reading = await readWindowsPower();
        return { kind: "windows", reading, power: windowsFindings(reading) };
    }
    if (side === "wsl") {
        return { kind: "wsl" };
    }
    if (process.platform === "linux") {
        const reading = await readLinuxPower();
        return { kind: "linux", reading, power: linuxFindings(reading) };
    }
    if (process.platform === "darwin") {
        const reading = await readMacPower();
        return { kind: "macos", reading, power: macFindings(reading) };
    }
    return { kind: "other", platform: process.platform };
};

// The reading, only where this environment owns the settings.
const readPowerFacts = async (): Promise<HostPower | undefined> => {
    const here = await readPowerHere();
    return "power" in here ? here.power : undefined;
};

/* The facts are asked at every hello and every two minutes, and the settings change when a person changes them: a
   reading is kept five minutes, and an older one is answered while the next is read, so describe never waits on
   PowerShell but for the very first reading, and then at most a few seconds (on rog the read takes about a second).
   A read that fails is said once, until one works again, and the last reading stands; with none yet the field is absent.

   A reading taken before `power stay-on` or `power restore` changed the settings is dropped at once, so the facts the
   daemon reads right after the owner's yes say what Windows holds now, not "sleeps after 5 hours" for five more
   minutes. Both runs touch a stamp file when they wrote anything (apply.ts, `power-changed`), whoever ran them: the
   sandbox's op as a detached child of this agent, or a person in a terminal. Each ask compares the stamp's time with
   the one seen when the kept reading began, a stat and nothing more; the op also forgets the reading itself as it
   ends (device/tools/agent.ts), should the stamp not have been written. */
export const POWER_REFRESH_MS = 5 * 60_000;
const POWER_FIRST_WAIT_MS = 3_000;

export interface PowerWatch {
    // The reading, never throwing; undefined where there is none (yet), or this environment does not own the settings.
    readonly current: (log: (message: string) => void) => Promise<HostPower | undefined>;
    // Forgets it, so the next `current` reads afresh and waits for it: after this agent changed the settings.
    readonly forget: () => void;
}

interface PowerWatchDeps {
    readonly read: () => Promise<HostPower | undefined>;
    // The time stay-on or restore last changed the settings (the stamp's mtime), undefined where neither has.
    readonly changedAt?: () => Promise<number | undefined>;
    readonly now?: () => number;
    readonly refreshMs?: number;
    readonly firstWaitMs?: number;
}

const waitAtMost = async (work: Promise<void>, ms: number): Promise<void> => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
        timer.unref();
    });
    try {
        await Promise.race([work, timeout]);
    } finally {
        clearTimeout(timer);
    }
};

export const createPowerWatch = ({
    read,
    changedAt = () => Promise.resolve(undefined),
    now = Date.now,
    refreshMs = POWER_REFRESH_MS,
    firstWaitMs = POWER_FIRST_WAIT_MS,
}: PowerWatchDeps): PowerWatch => {
    let power: HostPower | undefined;
    // The stamp as it stood when the kept reading began: a different one means the settings changed under it.
    let powerStamp: number | undefined;
    let readAt = Number.NEGATIVE_INFINITY;
    let underway: Promise<void> | undefined;
    let failing = false;
    // A read started before a forget answers about the settings before the change: its answer is dropped.
    let generation = 0;
    const refresh = (log: (message: string) => void, stamp: number | undefined): Promise<void> => {
        const started = generation;
        readAt = now();
        const work = read()
            .then((answer) => {
                if (started === generation) {
                    power = answer;
                    powerStamp = stamp;
                }
                failing = false;
            })
            .catch((error: Error) => {
                if (!failing) {
                    log(`reading this computer's power settings failed (the last reading stands): ${errorMessage(error).split("\n")[0] ?? ""}`);
                }
                failing = true;
            })
            .finally(() => {
                if (underway === work) {
                    underway = undefined;
                }
            });
        underway = work;
        return work;
    };
    const forget = (): void => {
        generation += 1;
        power = undefined;
        readAt = Number.NEGATIVE_INFINITY;
        underway = undefined;
    };
    return {
        current: async (log) => {
            // allow(silent-catch): no stamp means no change was made since the agent started, which is what undefined says
            const stamp = await changedAt().catch(() => undefined);
            if (power !== undefined && stamp !== powerStamp) {
                forget();
            }
            const running = underway ?? (now() - readAt >= refreshMs ? refresh(log, stamp) : undefined);
            if (power === undefined && running !== undefined) {
                await waitAtMost(running, firstWaitMs);
            }
            return power;
        },
        forget,
    };
};

const stampTime = async (): Promise<number | undefined> => await stat(powerChangedPath).then(
    (stats) => stats.mtimeMs,
    () => undefined,
);

let watch: PowerWatch | undefined;

/** The device facts' `power`: this environment's reading, kept five minutes; undefined where it does not own them. */
export const powerFacts = async (log: (message: string) => void): Promise<HostPower | undefined> => await (watch ??= createPowerWatch({ read: readPowerFacts, changedAt: stampTime })).current(log);

/** After this agent changed the settings (the `power-stay-on` op): the next facts read them again. */
export const forgetPowerReading = (): void => {
    watch?.forget();
};
