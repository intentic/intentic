import type { LocalView } from "@intentic/web/local-host";
import { t } from "@intentic/ui/i18n";

// WHAT THE RAIL'S THIS DEVICE TILE SAYS while the reader is elsewhere (host.ts): a setup or a fix running here (the
// rail's spinning mark), a setup or a sync that stopped for the reader, Docker being started, an update waiting for a
// restart. Nothing at rest. Pure, so each case is tested by value (badge.test.ts).

export type DeviceBadge = NonNullable<LocalView[`badge`]>[`value`];

/** The facts of the device store (useDevice.ts) the tile reads. */
export interface DeviceSigns {
    /** A setup's script is running. */
    readonly settingUp: boolean;
    /** The name of the sandbox a setup is for, when it has one. */
    readonly sandbox: string | undefined;
    /** The sandbox the recovery panel's fix is running for (fix.ts), while it runs. */
    readonly fixing: string | undefined;
    /** A setup's card is on This device (finished or not), or a sync enrollment failed: both wait for the reader. */
    readonly waiting: boolean;
    readonly startingDocker: boolean;
    readonly updateReady: boolean;
}

/** One badge for the tile, the most pressing first: work in flight, then what waits for the reader, then news. */
export const deviceBadge = (signs: DeviceSigns): DeviceBadge => {
    if (signs.settingUp) {
        return { running: t(`desktop.device.settingUpBadge`, { name: signs.sandbox ?? t(`desktop.app.sandbox`) }) };
    }
    if (signs.fixing !== undefined) {
        return { running: t(`desktop.fix.fixing`, { sandbox: signs.fixing }) };
    }
    if (signs.waiting) {
        return { mark: `exclamation`, tone: `warning`, tooltip: t(`desktop.device.needsYouBadge`) };
    }
    if (signs.startingDocker) {
        return { running: t(`desktop.device.startingDockerBadge`) };
    }
    if (signs.updateReady) {
        return { mark: `arrow-up`, tone: `info`, tooltip: t(`desktop.device.updateReadyBadge`) };
    }
    return undefined;
};
