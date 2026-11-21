import { isWslDevice } from "@intentic/sandbox-contract/schemas/devices";
import { DEVICE_FEATURE_REMOTE_SERVICE, deviceSupports } from "@intentic/sandbox-contract/schemas/hosts";
import { t } from "@intentic/ui/i18n";
import type { DeviceRow } from "../deviceRows";
import type { RemoteServiceChange, RemoteServiceState } from "./remoteApi";

// WINDOWS' LOCK SCREEN AND ADMINISTRATOR PROMPTS, AS A COMPUTER'S REMOTE ACCESS SECTION OFFERS THEM: one row for the
// computer's Windows side, whose control says whether remoted's Windows service is set up there and offers the one thing
// to do about it (set it up, update it, remove it), or says why nothing can be said. Setting it up or removing it waits
// on the administrator's yes on that computer, which the control says while it waits. Pure: the row reads the status and
// hands it here.

/** One status read: still asking, its answer, or the sandbox's refusal in its own sentence. */
export type ServiceRead =
    | { readonly kind: `waiting` }
    | { readonly kind: `answered`; readonly service: RemoteServiceState }
    | { readonly kind: `refused`; readonly reason: string };

export interface ServiceView {
    // What the service is, or why nothing can be said of it.
    readonly state: string;
    // A reason, a wait or a check rather than a state: drawn quieter.
    readonly muted: boolean;
    // The one thing to do about it; absent when there is none, or the reader may not.
    readonly action?: { readonly change: RemoteServiceChange; readonly label: string } | undefined;
}

/** The computer's Windows side, where the service is set up; undefined on a computer that has none with a door. */
export const serviceSide = (environments: readonly DeviceRow[]): DeviceRow | undefined =>
    environments.find(
        (environment) =>
            environment.device.hostId !== undefined &&
            !isWslDevice(environment.device) &&
            (environment.device.platform === `windows` || deviceSupports(environment.device.facts, DEVICE_FEATURE_REMOTE_SERVICE)),
    );

/** Whether the status is worth asking: the side is online, and its agent has the service (or has not said yet). */
export const serviceWanted = (row: DeviceRow): boolean =>
    row.device.online === true && (row.device.facts === undefined || deviceSupports(row.device.facts, DEVICE_FEATURE_REMOTE_SERVICE));

const said = (state: string): ServiceView => ({ state, muted: true });

const ofAnswer = (service: RemoteServiceState, editable: boolean): ServiceView => {
    if (!service.supported) {
        return said(service.reason ?? t(`sandbox.deviceRemote.serviceUnsupported`));
    }
    const offer = (change: RemoteServiceChange, label: string) => (editable ? { change, label } : undefined);
    if (!service.installed) {
        return { state: t(`sandbox.deviceRemote.serviceNotSetUp`), muted: false, action: offer(`install`, t(`sandbox.deviceRemote.serviceInstall`)) };
    }
    if (service.outOfDate) {
        return { state: t(`sandbox.deviceRemote.serviceOlder`), muted: false, action: offer(`install`, t(`sandbox.deviceRemote.serviceUpdate`)) };
    }
    return { state: t(`sandbox.deviceRemote.serviceSetUp`), muted: false, action: offer(`uninstall`, t(`sandbox.deviceRemote.serviceRemove`)) };
};

/**
 * What the row's control says and offers. `asking` is a change waiting on the computer's UAC prompt now; `machineName`
 * is the computer, as the person knows it. `editable` is Full access: anyone else reads the state and is offered nothing.
 */
export const serviceView = (row: DeviceRow, machineName: string, read: ServiceRead | undefined, asking: boolean, editable: boolean): ServiceView => {
    if (asking) {
        return said(t(`sandbox.deviceRemote.serviceWaiting`, { name: machineName }));
    }
    if (row.device.online !== true) {
        return said(t(`sandbox.deviceRemote.offline`, { name: machineName }));
    }
    if (row.device.facts !== undefined && !deviceSupports(row.device.facts, DEVICE_FEATURE_REMOTE_SERVICE)) {
        return said(t(`sandbox.deviceRemote.serviceOlderAgent`, { name: machineName }));
    }
    if (read === undefined || read.kind === `waiting`) {
        return said(t(`sandbox.deviceRemote.checking`));
    }
    return read.kind === `refused` ? said(read.reason) : ofAnswer(read.service, editable);
};

/** What the last change came to, when the computer's administrator did not say yes; undefined otherwise. */
export const serviceDeclined = (last: RemoteServiceState | undefined, machineName: string): string | undefined =>
    last?.declined === true ? t(`sandbox.deviceRemote.serviceDeclined`, { name: machineName }) : undefined;
