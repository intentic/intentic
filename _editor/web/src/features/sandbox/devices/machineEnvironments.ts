import type { RouteLocationRaw } from "vue-router";
import { deviceDoors, osLabel } from "./deviceFacts";
import type { DeviceRow, MachineRow } from "./deviceRows";

// One environment of a many-sided machine as its row states it: the door its tools are named after, the shell
// behind it, its home, and how this sandbox reaches it. Nothing here is a verdict; those come from deviceRows.

export const environmentTitle = (row: DeviceRow): string => osLabel(row.device) ?? row.device.label;

// The facts in one line, quietest ink: the door id leads because it is the string every tool and skill is named
// after, and the one thing two environments of a machine never share.
export const environmentFacts = (row: DeviceRow): string[] => [
    ...(row.device.hostId === undefined ? [] : [row.device.hostId]),
    ...(row.device.facts === undefined ? [] : [row.device.facts.shell, row.device.facts.home]),
    ...deviceDoors(row.device).map((door) => door.name),
];

// A distro the Windows side lists, and whether this sandbox already holds a door into it. `connectName` is the
// name the Linux card's add form is opened with, so the two ids read as one PC on every screen.
export interface WslDistroRow {
    readonly name: string;
    readonly connectedAs: string | undefined;
    readonly connect: RouteLocationRaw;
}

const distroOf = (row: DeviceRow): string | undefined => (row.device.facts?.wsl ?? row.device.report?.wsl)?.distro;

// The Windows environment's distros, from its own listing. Empty on a machine with no Windows side, or one whose
// agent is too old to list them.
export const wslDistroRows = (machine: MachineRow): WslDistroRow[] => {
    const windows = machine.environments.find((environment) => environment.device.facts?.wslDistros !== undefined);
    if (windows === undefined) {
        return [];
    }
    const stem = windows.device.hostId ?? machine.label;
    return (windows.device.facts?.wslDistros ?? []).map((name) => {
        const connected = machine.environments.find((environment) => distroOf(environment) === name);
        return {
            name,
            connectedAs: connected === undefined ? undefined : (connected.device.hostId ?? connected.device.label),
            connect: { name: `capabilities`, params: { card: `linux` }, query: { device: `${stem}-wsl-${name.toLowerCase()}` } },
        };
    });
};
