import type { LocalView } from "@intentic/web/local-host";
import { t } from "@intentic/ui/i18n";
import type { MachineStanding } from "../desktop";

// WHAT THE RAIL'S THIS DEVICE TILE SAYS while the reader is elsewhere (host.ts): a setup, a fix or a move between engines
// running here (the rail's spinning mark), this computer's own sandbox being made, a setup, a sync or this computer's
// sandbox stopped for the reader, Docker being started, an update waiting for a restart. Nothing at rest. Pure, so each
// case is tested by value (badge.test.ts).

export type DeviceBadge = NonNullable<LocalView[`badge`]>[`value`];

/** The facts of the device store (useDevice.ts) the tile reads. */
export interface DeviceSigns {
    /** A setup's script is running. */
    readonly settingUp: boolean;
    /** The name of the sandbox a setup is for, when it has one. */
    readonly sandbox: string | undefined;
    /** The sandbox the recovery panel's fix is running for (fix.ts), while it runs. */
    readonly fixing: string | undefined;
    /** The sandboxes are moving to another engine (engine.ts), from whichever window or Repair. */
    readonly movingSandboxes?: boolean;
    /** A setup's card is on This device (finished or not), or a sync enrollment failed: both wait for the reader. */
    readonly waiting: boolean;
    readonly startingDocker: boolean;
    readonly updateReady: boolean;
    /** Where this computer's own sandbox stands (machineSandbox.ts), once the app has said. */
    readonly machine?: MachineStanding[`state`] | undefined;
}

// This computer's sandbox waiting on the reader: a question, a failure, Docker, a stopped container, one that is gone.
// Nobody signed in is not one: it is made after sign-in.
const MACHINE_NEEDS_YOU: ReadonlySet<MachineStanding[`state`]> = new Set([`waiting`, `failed`, `needsDocker`, `stopped`, `gone`]);

/** One badge for the tile, the most pressing first: work in flight, then what waits for the reader, then news. */
export const deviceBadge = (signs: DeviceSigns): DeviceBadge => {
    if (signs.settingUp) {
        return { running: t(`desktop.device.settingUpBadge`, { name: signs.sandbox ?? t(`desktop.app.sandbox`) }) };
    }
    if (signs.fixing !== undefined) {
        return { running: t(`desktop.fix.fixing`, { sandbox: signs.fixing }) };
    }
    if (signs.movingSandboxes === true) {
        return { running: t(`desktop.engine.movingBadge`) };
    }
    if (signs.machine === `creating` || signs.machine === `interrupted`) {
        return { running: t(`desktop.device.machineBadge`) };
    }
    if (signs.waiting) {
        return { mark: `exclamation`, tone: `warning`, tooltip: t(`desktop.device.needsYouBadge`) };
    }
    if (signs.startingDocker) {
        return { running: t(`desktop.device.startingDockerBadge`) };
    }
    // Behind a start of Docker: that start is what most of these are waiting for.
    if (signs.machine !== undefined && MACHINE_NEEDS_YOU.has(signs.machine)) {
        return { mark: `exclamation`, tone: `warning`, tooltip: t(`desktop.device.needsYouBadge`) };
    }
    if (signs.updateReady) {
        return { mark: `arrow-up`, tone: `info`, tooltip: t(`desktop.device.updateReadyBadge`) };
    }
    return undefined;
};
