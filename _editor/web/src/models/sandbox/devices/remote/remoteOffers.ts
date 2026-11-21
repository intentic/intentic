import { deviceEnvironment } from "@intentic/sandbox-contract/schemas/devices";
import { DEVICE_FEATURE_REMOTE, deviceSupports, HOST_NATIVE_ENVIRONMENT } from "@intentic/sandbox-contract/schemas/hosts";
import { t } from "@intentic/ui/i18n";
import type { DeviceRow } from "../deviceRows";
import type { RemoteMonitor, RemoteStatus, RemoteTerminalInfo } from "./remoteApi";

// WHAT ONE COMPUTER CAN OFFER A PERSON NOW: per environment (Windows and each distro connected on it), whether its screen
// and a terminal can be opened, and when not, the one sentence that says why, read in the order a person would ask it:
// is it there at all (offline), can it do this at all (an agent from before remote access), will it now (the sandbox's
// own answer, which names a switch that is off or anything else in the way). Pure: the page reads each environment's
// status and hands it here.

export type Offer = { readonly ready: true } | { readonly ready: false; readonly reason: string };

/** One environment's status read: still asking, its answer, or the sandbox's refusal in its own sentence. */
export type StatusRead =
    | { readonly kind: `waiting` }
    | { readonly kind: `answered`; readonly status: RemoteStatus }
    | { readonly kind: `refused`; readonly reason: string };

export interface RemoteSide {
    readonly row: DeviceRow;
    // The connection the remote procedures name (`rog`, `rog::wsl:archlinux`).
    readonly device: string;
    // `native`, or `wsl:<distro>`: the environment this connection's own agent serves, where its terminal opens. Each
    // connection is served by its own remoted (the sandbox's hosts/remote/remote-environments.ts has the rule), so a
    // distro's terminal is a native shell there, never one the Windows side opens into it.
    readonly environment: string;
    // Why nothing on this side can be opened now, said once for both of its buttons.
    readonly blocked?: string | undefined;
    // Still asking the sandbox: the buttons wait without a reason.
    readonly checking: boolean;
    // Undefined where this side has no screen of its own (a distro): no button rather than a dead one.
    readonly screen: Offer | undefined;
    readonly terminal: Offer;
    readonly monitors: readonly RemoteMonitor[];
    readonly terminals: readonly RemoteTerminalInfo[];
}

const READY: Offer = { ready: true };
const off = (reason: string): Offer => ({ ready: false, reason });

/** Whether this side is worth asking: it has a command door, is online, and its agent can serve remote access. */
export const statusWanted = (row: DeviceRow): boolean =>
    row.device.hostId !== undefined &&
    row.device.online === true &&
    (row.device.facts === undefined || deviceSupports(row.device.facts, DEVICE_FEATURE_REMOTE));

// Why the side cannot even be asked, before any status: undefined when it can.
const blockedBefore = (row: DeviceRow): string | undefined => {
    if (row.device.online !== true) {
        return t(`sandbox.deviceRemote.offline`, { name: row.device.label });
    }
    if (row.device.facts !== undefined && !deviceSupports(row.device.facts, DEVICE_FEATURE_REMOTE)) {
        return t(`sandbox.deviceRemote.olderAgent`, { name: row.device.label });
    }
    return undefined;
};

// The PC's screen is its native side's alone; a distro's own remoted names none (the sandbox drops any it does). A native
// side with no screen to show says why when remoted knows (no display and no Xvfb: what to install), rather than hiding
// the button and leaving the person to guess.
const screenOffer = (native: boolean, status: RemoteStatus): Offer | undefined => {
    if (!native) {
        return undefined;
    }
    if (status.monitors.length === 0) {
        return status.screenReason === undefined ? undefined : off(status.screenReason);
    }
    return status.allow.view ? READY : off(t(`sandbox.deviceRemote.viewOff`));
};

/** One environment's offers, or undefined for a row with no command door (nothing remote reaches it). */
export const remoteSide = (row: DeviceRow, read: StatusRead | undefined): RemoteSide | undefined => {
    const device = row.device.hostId;
    if (device === undefined) {
        return undefined;
    }
    const environment = deviceEnvironment(row.device) ?? HOST_NATIVE_ENVIRONMENT;
    const native = environment === HOST_NATIVE_ENVIRONMENT;
    const base = { row, device, environment, monitors: [], terminals: [] };
    const blocked = blockedBefore(row) ?? (read?.kind === `refused` ? read.reason : undefined);
    if (blocked !== undefined) {
        return { ...base, blocked, checking: false, screen: native ? off(blocked) : undefined, terminal: off(blocked) };
    }
    if (read?.kind !== `answered`) {
        const waiting = off(``);
        return { ...base, checking: true, screen: native ? waiting : undefined, terminal: waiting };
    }
    const { status } = read;
    if (!status.available) {
        const reason = status.reason ?? t(`sandbox.deviceRemote.unavailable`);
        return { ...base, blocked: reason, checking: false, screen: native ? off(reason) : undefined, terminal: off(reason) };
    }
    return {
        ...base,
        checking: false,
        monitors: status.monitors,
        terminals: status.terminals,
        screen: screenOffer(native, status),
        terminal: status.allow.terminal ? READY : off(t(`sandbox.deviceRemote.terminalOff`)),
    };
};

/** The environment's own name as a person knows it: the OS for the native side, the distro's name for one in WSL. */
export const environmentName = (environment: string, nativeName: string): string =>
    environment.startsWith(`wsl:`) ? environment.slice(`wsl:`.length) : nativeName;

/** A device terminal's tab title: the computer, then where on it the shell runs. */
export const terminalTitle = (machine: string, environment: string, nativeName: string): string =>
    `${machine} · ${environmentName(environment, nativeName)}`;

/** The monitor a screen opens on unless one is picked: the primary, else the first listed. */
export const primaryMonitor = (monitors: readonly RemoteMonitor[]): RemoteMonitor | undefined =>
    monitors.find((monitor) => monitor.primary) ?? monitors[0];
