import type { RouteLocationRaw } from "vue-router";
import { deviceDoors, osLabel, osTitle } from "./deviceFacts";
import type { DeviceRow, MachineRow } from "./deviceRows";

// One environment of a many-sided machine as its row states it: the door its tools are named after, the shell
// behind it, its home, and how this sandbox reaches it. Nothing here is a verdict; those come from deviceRows.

export const environmentTitle = (row: DeviceRow): string => osLabel(row.device) ?? row.device.label;

// The ONE fact under the name: the door id, which is the string every tool and skill is named after and the one
// thing two environments of a machine never share. A row with no command door says so instead — an absent door
// is worth a word, a present one is the normal case and was four rows of "commands" saying nothing.
export const environmentIdentity = (row: DeviceRow): string | undefined =>
    row.device.hostId ?? (deviceDoors(row.device).length === 0 ? undefined : `desktop sync only`);

/** Whether that identity is a door id, which is set in mono; the fallback clause is prose. */
export const environmentAddressed = (row: DeviceRow): boolean => row.device.hostId !== undefined;

// What the row used to print beside the name, kept for the reader who wants it: the OS in full where it says more
// than the title does, what shell to type in, where home is, and how this sandbox reaches the environment at all.
export const environmentDetail = (row: DeviceRow): string | undefined => {
    const parts = [
        osTitle(row.device),
        ...(row.device.facts === undefined ? [] : [row.device.facts.shell, row.device.facts.home]),
        ...deviceDoors(row.device).map((door) => door.name),
    ].filter((part) => part !== undefined && part !== ``);
    return parts.length === 0 ? undefined : parts.join(` · `);
};

// A distro the Windows side lists that this sandbox holds NO door into: the ones it does hold are the rows above,
// and naming them twice is what made this block read as a second environment list. `connect` is the Linux card's
// add form, opened with the name that makes the two ids read as one PC on every screen.
export interface WslDistroRow {
    readonly name: string;
    readonly connect: RouteLocationRaw;
}

const distroOf = (row: DeviceRow): string | undefined => (row.device.facts?.wsl ?? row.device.report?.wsl)?.distro;

// The Windows environment's distros, from its own listing, minus every one already standing as a row of its own.
// Empty on a machine with no Windows side, one whose agent is too old to list them, and one where every distro is
// already connected — which is the common case and now costs the page nothing.
export const wslDistroRows = (machine: MachineRow): WslDistroRow[] => {
    const windows = machine.environments.find((environment) => environment.device.facts?.wslDistros !== undefined);
    if (windows === undefined) {
        return [];
    }
    const stem = windows.device.hostId ?? machine.label;
    return (windows.device.facts?.wslDistros ?? [])
        .filter((name) => !machine.environments.some((environment) => distroOf(environment) === name))
        .map((name) => ({
            name,
            connect: { name: `capabilities`, params: { card: `linux` }, query: { device: `${stem}-wsl-${name.toLowerCase()}` } },
        }));
};
