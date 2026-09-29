import { deviceDistro, userDistrosOf } from "@intentic/sandbox-contract";
import type { Tip } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import type { RouteLocationRaw } from "vue-router";
import { deviceDoors, osLabel, osTitle } from "./deviceFacts";
import { capabilityRoute } from "./deviceLinks";
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
// A card of figures, not a joined line: each fact gets its own label, and one the device never stated drops out.
export const environmentDetail = (row: DeviceRow): Tip | undefined => {
    const rows = [
        { label: t(`sandbox.words.os`), value: osTitle(row.device) ?? `` },
        { label: t(`sandbox.words.shell`), value: row.device.facts?.shell ?? `` },
        { label: t(`sandbox.words.home`), value: row.device.facts?.home ?? `` },
        {
            label: t(`sandbox.words.access`),
            value: deviceDoors(row.device)
                .map((door) => door.name)
                .join(`, `),
        },
    ].filter((fact) => fact.value !== ``);
    return rows.length === 0 ? undefined : { title: environmentTitle(row), rows };
};

// A distro the Windows side lists that this sandbox holds NO door into: the ones it does hold are the rows above,
// and naming them twice is what made this block read as a second environment list. `connect` is the Linux card's
// add form, opened with the name that makes the two ids read as one PC on every screen.
export interface WslDistroRow {
    readonly name: string;
    readonly connect: RouteLocationRaw;
}

// Read through the door id as well as the facts: a sleeping distro describes itself with nothing else, and listing it
// as one this sandbox has no door into is offering to connect what is already connected.
const distroOf = (row: DeviceRow): string | undefined => deviceDistro(row.device);

// The Windows environment's distros, from its own listing, minus every one already standing as a row of its own.
// Empty on a machine with no Windows side, one whose agent is too old to list them, and one where every distro is
// already connected — which is the common case and now costs the page nothing.
export const wslDistroRows = (machine: MachineRow): WslDistroRow[] => {
    const windows = machine.environments.find((environment) => environment.device.facts?.wslDistros !== undefined);
    if (windows === undefined) {
        return [];
    }
    const stem = windows.device.hostId ?? machine.label;
    return userDistrosOf(windows.device.facts)
        .filter((name) => !machine.environments.some((environment) => distroOf(environment) === name))
        .map((name) => ({
            name,
            connect: capabilityRoute(`linux`, { device: `${stem}-wsl-${name.toLowerCase()}` }),
        }));
};
