import type { Device } from "@intentic/sandbox-contract";
import type { StatusVariant } from "@intentic/ui";
import { hostCard, osLabel } from "../../sandbox/devices/deviceFacts";
import { deviceState, deviceTone } from "../../sandbox/devices/deviceRows";

// Machines this sandbox can see that no capability card accounts for. A device arrives through either of two doors:
// a `host` capability, which is a card, and a desktop-sync enrollment, which deliberately is not — a laptop syncing
// files never had to grant anyone a shell on it. Only the first door was ever a capability, so Capabilities and the
// Devices board answered "which machines do I have" with different lists, and only one of them was complete.
//
// The daemon's device registry (`/system/devices`, hosts/device-reports.ts) is the one list; these turn its rows into
// the vocabulary a card states its connections in, so both screens are drawing the same answer.

/** One machine present through desktop sync alone, as the card it would be connected on would state it. */
export interface DeviceConnection {
    /** Synthetic and prefixed: nothing keyed on capability ids may mistake this for an instance of one. */
    readonly id: string;
    /** The card this machine belongs on, which is also where connecting it happens. */
    readonly cardId: string;
    readonly title: string;
    /** What tells it apart from another machine: its OS, and its hostname where that differs from its name. */
    readonly detail: string;
    /** Read from the same rules the Devices board reads, so the two screens cannot disagree about one machine. */
    readonly state: string;
    readonly tone: StatusVariant;
    readonly rank: number;
    /** Why it is listed here without being a connection: stated as the thing it cannot do. */
    readonly note: string;
    /** The machine's own name, for the revoke and connect paths that address it by that. */
    readonly machine: string;
}

const DEVICE_PREFIX = `device:`;

export const deviceConnectionId = (machine: string): string => `${DEVICE_PREFIX}${machine}`;

// Asked before anything treats a connection id as a capability's: these rows have no instance to open, so they land
// on the card itself rather than on a settings form for something that does not exist.
export const isDeviceConnection = (id: string): boolean => id.startsWith(DEVICE_PREFIX);

// The machine back out of a row's id, for the navigation that carries its name to the card's add form.
export const machineNamed = (id: string): string => (isDeviceConnection(id) ? id.slice(DEVICE_PREFIX.length) : id);

// Sorted the way connectionState ranks its own: trouble first, then what is merely off, then what is working.
const RANKS: Readonly<Record<string, number>> = { danger: 0, warning: 1, neutral: 2, success: 3 };

// The one line under the name. Hostname is added only where it differs, since repeating the row's own name teaches
// nothing and costs the line its width.
const detailOf = (device: Device): string => {
    const os = osLabel(device);
    const hostname = device.report?.hostname;
    const named = hostname !== undefined && hostname.toLowerCase() !== device.label.toLowerCase() ? hostname : undefined;
    return [os, named].filter((part) => part !== undefined && part !== ``).join(` · `);
};

/**
 * Rows for machines reached by desktop sync that hold no host capability. A machine whose platform has no card
 * (macOS today) is left out rather than pointed at a card that does not exist; the Devices board remains the place
 * every machine appears, whatever it runs.
 */
export const deviceConnections = (devices: readonly Device[], readAt: number): DeviceConnection[] =>
    devices.flatMap((device): DeviceConnection[] => {
        // A machine with a hostId is already a capability instance, and the card lists it the ordinary way.
        if (device.hostId !== undefined || device.sync === undefined) {
            return [];
        }
        const cardId = hostCard(device.platform);
        if (cardId === undefined) {
            return [];
        }
        const tone = deviceTone(device, readAt);
        return [
            {
                id: deviceConnectionId(device.label),
                cardId,
                title: device.label,
                detail: detailOf(device),
                state: deviceState(device, readAt),
                tone,
                rank: RANKS[tone] ?? 2,
                // Short on purpose: the row's own Connect button is what explains the rest.
                note: `no command access`,
                machine: device.label,
            },
        ];
    });
