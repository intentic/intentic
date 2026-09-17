import {
    agentBuildSkew,
    type Device,
    type DeviceAgent,
    type DevicePairing,
    type DevicePort,
    type DeviceSandbox,
    type DeviceSyncSwitch,
    type Machine,
    machinesOf,
} from "@intentic/sandbox-contract";
import type { StatusVariant } from "@intentic/ui";
import {
    type DeviceFolderRow,
    type DeviceSandboxGroup,
    folderConflicts,
    groupSummary,
    isSameSandbox,
    mirroringOff,
    sandboxGroups,
    syncSessionLive,
} from "@intentic/ui/device";
import {
    type AgentChip,
    agentChip,
    agentHalted,
    deviceDoors,
    deviceQuiet,
    deviceReconnecting,
    lastSeenNote,
    machineWarnings,
    osLabel,
} from "./deviceFacts";

// One device as the board and the device page both read it: its state in one word and one colour, its
// sandboxes folded into groups, and the agent verdicts a render needs; and one MACHINE, the PC those devices are
// environments of (Windows and the WSL distros on it), whose sandboxes are listed once. Pure throughout, so the
// same rules can be checked without mounting anything (deviceRows.test.ts).

// `readAt` is when the reading landed here, not the clock: see deviceFacts.ts.

export const deviceTone = (device: Device, readAt: number): StatusVariant => {
    if (device.gap !== undefined) {
        return device.gap === `offline` ? `neutral` : `warning`;
    }
    // A stalled agent is the same errand as a stopped one: nothing is reaching that device's ports or clones.
    if (deviceQuiet(device, readAt) || device.report?.agent.running === false || agentHalted(device)) {
        return `warning`;
    }
    return `success`;
};

// The badge's word must agree with its colour: a dead sync agent is amber, so it reads "needs attention"
// rather than "live".
export const deviceState = (device: Device, readAt: number): string => {
    // Said before the gap it is a case of: a socket dropped seconds ago is a machine on its way back, and calling
    // that offline is a verdict this row contradicts a second later.
    if (deviceReconnecting(device, readAt)) {
        return `reconnecting`;
    }
    if (device.gap !== undefined) {
        return device.gap === `offline` ? `offline` : `needs attention`;
    }
    if (deviceQuiet(device, readAt)) {
        return `gone quiet`;
    }
    return device.report?.agent.running === false || agentHalted(device) ? `needs attention` : `live`;
};

// Machines worth reading first: state leads, name breaks ties, so order only changes when a machine's state
// does. Live ranks above needs-attention, since a live card is the point of the board; a machine with several
// environments ranks by its best one, since that is the door that works.
const RANK: Record<string, number> = { live: 0, "needs attention": 1, "gone quiet": 2, reconnecting: 3, offline: 4 };

const machineRank = (machine: MachineRow, readAt: number): number =>
    Math.min(...machine.environments.map((environment) => RANK[deviceState(environment.device, readAt)] ?? 9));

export const sortMachines = (machines: readonly MachineRow[], readAt: number): MachineRow[] =>
    machines.toSorted((a, b) => machineRank(a, readAt) - machineRank(b, readAt) || a.label.localeCompare(b.label));

// The agent with this render's verdicts already attached; absent on a device that never reported.
export type RowAgent = DeviceAgent & {
    readonly stalled: boolean;
    readonly staleBuild?: { readonly running: string | undefined; readonly installed: string };
};

export interface DeviceRow {
    readonly device: Device;
    readonly groups: readonly DeviceSandboxGroup[];
    readonly agent: RowAgent | undefined;
    /** What the header says about the agent: build serving, an owed restart, a published update. */
    readonly chip: AgentChip | undefined;
}

// Grouped once per device rather than per template read, since the same grouping backs every count and
// warning both screens draw. Containers and folders/ports are two answers behind two switches, so a machine that
// listed its containers while refusing to describe itself still gets its rows, with nothing under them.
const groupsOf = (device: Device): DeviceSandboxGroup[] =>
    sandboxGroups(device.report?.pairings ?? [], device.report?.ports ?? [], device.sandboxes ?? []);

export const deviceRow = (device: Device, latest: string | undefined): DeviceRow => {
    const agent = device.report?.agent;
    // Whether this device serves an older build than the one installed (agentBuildSkew); no report means no
    // comparison.
    const staleBuild = agent === undefined ? undefined : agentBuildSkew(agent);
    return {
        device,
        groups: groupsOf(device),
        agent:
            agent === undefined ? undefined : { ...agent, stalled: agentHalted(device), ...(staleBuild === undefined ? {} : { staleBuild }) },
        chip: agentChip(device, latest),
    };
};

// One PC as the board draws it: its environments in the contract's order (Windows first), and its sandboxes once.
// A lone device is a machine of one environment whose groups are that device's own.
export interface MachineRow {
    readonly key: string;
    readonly label: string;
    readonly environments: readonly DeviceRow[];
    /** Containers deduped by slug across environments; every pairing and port kept, sync pairings leading. */
    readonly groups: readonly DeviceSandboxGroup[];
}

// The environment whose report carries this group's folder: the door its file-sync buttons go through. Matched
// on mode as well as id, since two environments can pair one sandbox in different modes.
export const folderOwner = (machine: MachineRow, group: DeviceSandboxGroup): DeviceRow | undefined =>
    group.folder === undefined
        ? undefined
        : machine.environments.find((environment) =>
              (environment.device.report?.pairings ?? []).some(
                  (pairing) => pairing.sandboxId === group.sandboxId && pairing.mode === group.folder?.mode,
              ),
          );

// The door container verbs go through: the first environment holding a socket. One engine serves every
// environment, so any open door manages every container.
export const managerOf = (machine: MachineRow): DeviceRow | undefined =>
    machine.environments.find((environment) => environment.device.hostId !== undefined && environment.device.online === true) ??
    machine.environments.find((environment) => environment.device.hostId !== undefined);

// The machine's three lists as one. Two environments of one PC list the same containers, so a slug is kept once
// (Windows leads, and both sides read the same engine); folders and ports are each environment's own and are all
// kept, sync pairings first so a folder that holds files outranks one that only mirrors ports when both name a
// sandbox. A lone device's lists are its own, in its own order.
export interface MachineLists {
    readonly pairings: readonly DevicePairing[];
    readonly ports: readonly DevicePort[];
    readonly sandboxes: readonly DeviceSandbox[];
}

export const machineLists = (environments: readonly DeviceRow[]): MachineLists => {
    const pairings = environments.flatMap((environment) => environment.device.report?.pairings ?? []);
    const sandboxes = new Map<string, DeviceSandbox>();
    for (const sandbox of environments.flatMap((environment) => environment.device.sandboxes ?? [])) {
        if (!sandboxes.has(sandbox.slug)) {
            sandboxes.set(sandbox.slug, sandbox);
        }
    }
    return {
        pairings: environments.length > 1 ? pairings.toSorted((a, b) => Number(a.mode !== `sync`) - Number(b.mode !== `sync`)) : pairings,
        ports: environments.flatMap((environment) => environment.device.report?.ports ?? []),
        sandboxes: [...sandboxes.values()],
    };
};

export const machineRow = (environments: readonly DeviceRow[], { key, label }: Pick<Machine, `key` | `label`>): MachineRow => {
    const lists = machineLists(environments);
    return { key, label, environments, groups: sandboxGroups(lists.pairings, lists.ports, lists.sandboxes) };
};

export const machineRows = (devices: readonly Device[], latest: string | undefined, readAt: number): MachineRow[] =>
    sortMachines(
        machinesOf(devices).map((machine) =>
            machineRow(
                machine.environments.map((device) => deviceRow(device, latest)),
                machine,
            ),
        ),
        readAt,
    );

// Whether the machine holds more than one environment: the case the board and the page draw differently.
export const manySided = (machine: MachineRow): boolean => machine.environments.length > 1;

// The sandbox you're looking at, matched by its container slug on the machine. Both sides must be known:
// comparing two optionals let a pairing with no container on an unknown-URL sandbox match
// `undefined === undefined` and falsely claim to be the one in use.
export const isSelf = (device: Device, group: DeviceSandboxGroup, ownSlug: string | undefined): boolean =>
    device.hostId !== undefined && ownSlug !== undefined && group.sandbox?.slug === ownSlug;

// Any environment's door onto the container serving this page names the machine as the one in use.
export const isSelfMachine = (machine: MachineRow, group: DeviceSandboxGroup, ownSlug: string | undefined): boolean =>
    machine.environments.some((environment) => isSelf(environment.device, group, ownSlug));

export const selfGroup = (machine: MachineRow, ownSlug: string | undefined): DeviceSandboxGroup | undefined =>
    machine.groups.find((group) => isSelfMachine(machine, group, ownSlug));

// The machine holding this sandbox's desktop-sync pairing and no command door. A different question from
// `hostRunningSandbox`, which asks whose docker holds the container and can only ever answer with a device already
// connected — the answer every "do it for you instead of printing a command" path needs, and the one that is
// missing precisely when the command is printed. Syncing is not proof of hosting (a laptop can sync into a sandbox
// running elsewhere), so this names a machine worth offering to connect, never the machine this sandbox runs on.
export const deviceSyncingSandbox = (devices: readonly Device[], slug: string | undefined): Device | undefined =>
    slug === undefined || slug === ``
        ? undefined
        : devices.find(
              (device) =>
                  device.hostId === undefined &&
                  (device.report?.pairings ?? []).some((pairing) => pairing.mode === `sync` && isSameSandbox(pairing.sandboxId, slug)),
          );

// Container verbs show only where a click can work: the machine is a reachable connected device, and the
// row is a real container rather than a bare pairing.
export const manageable = (device: Device, group: DeviceSandboxGroup): boolean =>
    device.hostId !== undefined && device.online === true && group.sandbox !== undefined;

// What this device is doing for this sandbox, and how to change it: file syncing, port mirroring, and
// unpairing, which ends both. The machine owns all three, so all three need its own socket.
export const commandable = (device: Device, group: DeviceSandboxGroup): boolean =>
    device.hostId !== undefined && device.online === true && device.gap === undefined && group.folder !== undefined;

// Offered only where there's a running file sync to pause: a mirror-only enrollment has no session for it, and
// neither does a sync pairing whose sandbox was unreachable when its session was due — asking the machine to
// pause that one is asking Mutagen for a name it cannot resolve.
export const pausable = (device: Device, group: DeviceSandboxGroup): boolean =>
    commandable(device, group) && syncSessionLive(group.folder);

// A conflict between two EDITED copies has no switch: choosing between them is judgement per file, so the
// control is a turn an agent can run against both ends, not a one-click winner. Offered only where at least
// one conflict is of that kind — a folder stuck entirely on its own build output needs no judgement and no
// turn, and spending one on it taught readers that every conflict here costs an agent.
export const fixable = (device: Device, group: DeviceSandboxGroup): boolean =>
    commandable(device, group) && (folderConflicts(group.folder)?.disputed ?? 0) > 0;

// The other half: build output on this device standing in the way of deletions the sandbox already made.
// Nothing to judge, so it is a button, and the machine's own agent is already clearing these unprompted —
// this is for somebody who is watching and does not want to wait for the next pass.
export const clearable = (device: Device, group: DeviceSandboxGroup): boolean =>
    commandable(device, group) && (folderConflicts(group.folder)?.clearable ?? 0) > 0;

const has = (needle: string, ...fields: (string | undefined)[]): boolean =>
    fields.some((field) => field !== undefined && field.toLowerCase().includes(needle));

// Port numbers are matched too: "which machine has 8788" is the single most common reason to open this tab.
export const groupMatches = (group: DeviceSandboxGroup, needle: string): boolean =>
    has(needle, group.title, group.subtitle, group.sandboxId, group.sandbox?.slug, group.sandbox?.image, group.folder?.localDir) ||
    group.ports.some((port) => String(port.port).includes(needle));

const deviceMatches = (row: DeviceRow, needle: string): boolean =>
    has(needle, row.device.label, row.device.key, osLabel(row.device), row.device.hostId, row.device.report?.hostname);

export const rowMatches = (machine: MachineRow, needle: string): boolean =>
    has(needle, machine.label, machine.key) ||
    machine.environments.some((environment) => deviceMatches(environment, needle)) ||
    machine.groups.some((group) => groupMatches(group, needle));

// Shown only once there's enough to search: a filter over two machines costs more attention than it saves.
const FILTER_FLOOR = 3;

export const showFilter = (machines: readonly MachineRow[]): boolean =>
    machines.length > 2 || machines.reduce((total, machine) => total + machine.groups.length, 0) > FILTER_FLOOR;

// One sandbox as a board card states it, on a card nothing expands: enough to answer "which machine has
// this" and "is it fine", and nothing that needs a click.
export interface BoardLine {
    readonly sandboxId: string;
    readonly title: string;
    /** Absent on a pairing with no container on the machine. */
    readonly running: boolean | undefined;
    readonly facts: readonly string[];
    readonly warnings: readonly string[];
    readonly self: boolean;
}

// How many sandbox lines a card draws before it stops counting; a machine holding a dozen would otherwise
// be the whole board.
const BOARD_LINES_MAX = 3;

// One environment of a many-sided machine, as its own line on the card: what it is, how it is reached, and its
// own state, since a PC with a live Windows side and a stopped distro has no single word for itself.
export interface BoardEnvironment {
    readonly key: string;
    readonly label: string;
    readonly doors: readonly string[];
    readonly state: string;
    readonly tone: StatusVariant;
    readonly lastSeen: string | undefined;
}

export interface BoardBody {
    /** The doors this sandbox reaches the machine through, then the build its agent serves; a lone device's only. */
    readonly doors: readonly string[];
    /** One line per environment on a many-sided machine; empty on a lone device, whose facts ride the card itself. */
    readonly environments: readonly BoardEnvironment[];
    readonly lines: readonly BoardLine[];
    /** Sandboxes those lines do not account for, counted against what the machine reported. */
    readonly more: number;
    /** What is wrong with the machine itself; each line above carries its own. */
    readonly warnings: readonly string[];
}

const doorsOf = (row: DeviceRow): string[] => [
    ...deviceDoors(row.device).map((door) => door.name),
    ...(row.chip === undefined ? [] : [`agent ${row.chip.version}`]),
];

const boardEnvironment = (row: DeviceRow, readAt: number): BoardEnvironment => ({
    key: row.device.key,
    label: osLabel(row.device) ?? row.device.label,
    doors: doorsOf(row),
    state: deviceState(row.device, readAt),
    tone: deviceTone(row.device, readAt),
    lastSeen: lastSeenNote(row.device),
});

// A many-sided machine's warnings name the side they are about; a lone device's need no prefix.
const boardWarnings = (machine: MachineRow, readAt: number): readonly string[] =>
    manySided(machine)
        ? machine.environments.flatMap((environment) =>
              machineWarnings(environment.device, readAt).map((warning) => `${osLabel(environment.device) ?? environment.device.label}: ${warning}`),
          )
        : machineWarnings(machine.environments[0]?.device ?? { key: ``, label: `` }, readAt);

// While the filter is active every matching sandbox is drawn, however many: a port search whose answer was
// the fourth line would otherwise land on a card that doesn't show it.
export const boardBody = (machine: MachineRow, needle: string, ownSlug: string | undefined, readAt: number): BoardBody => {
    const matched = needle === `` ? machine.groups : machine.groups.filter((group) => groupMatches(group, needle));
    const shown = needle === `` ? matched.slice(0, BOARD_LINES_MAX) : matched;
    const lone = manySided(machine) ? undefined : machine.environments[0];
    return {
        doors: lone === undefined ? [] : doorsOf(lone),
        environments: lone === undefined ? machine.environments.map((environment) => boardEnvironment(environment, readAt)) : [],
        lines: shown.map((group) => {
            const summary = groupSummary(group);
            return {
                sandboxId: group.sandboxId,
                title: group.title,
                running: group.sandbox?.running,
                facts: summary.facts,
                warnings: summary.warnings,
                self: isSelfMachine(machine, group, ownSlug),
            };
        }),
        more: matched.length - shown.length,
        warnings: boardWarnings(machine, readAt),
    };
};

// The same two commands the pairing rows carry, run bare (no `--sandbox`), acting on every sandbox the
// device pairs — the answer to "I'm working on something else on this laptop".
type HalfState = `on` | `off` | `mixed`;

export interface DeviceHalf {
    readonly state: HalfState;
    /** How many of this machine's pairings are in the minority, for the sentence that explains a mixed row. */
    readonly off: number;
    readonly total: number;
}

// Absent `mirroring` reads as on, matching every agent older than the switch.
const halfOf = (pairings: readonly (DeviceFolderRow | undefined)[], isOff: (folder: DeviceFolderRow) => boolean): DeviceHalf => {
    const held = pairings.filter((folder): folder is DeviceFolderRow => folder !== undefined);
    const off = held.filter((folder) => isOff(folder)).length;
    const position: HalfState = off === 0 ? `on` : off === held.length ? `off` : `mixed`;
    return { state: position, off, total: held.length };
};

// Counted only over sync pairings; a machine holding only mirrors draws no file-sync switch at all.
export const syncHalf = (row: DeviceRow): DeviceHalf =>
    halfOf(
        row.groups.map((group) => group.folder).filter((folder) => folder?.mode === `sync`),
        (folder) => folder.paused === true,
    );

export const mirrorHalf = (row: DeviceRow): DeviceHalf => halfOf(row.groups.map((group) => group.folder), mirroringOff);

// Offered under the same three conditions as the per-pairing buttons, plus more than one pairing for that
// half: over a single pairing this would be that row's own button wearing a wider, scarier label.
const switchable = (row: DeviceRow, half: DeviceHalf): boolean =>
    row.device.hostId !== undefined && row.device.online === true && row.device.gap === undefined && half.total > 1;

// Both halves are the same shape (a state, a word, one or two commands), so one table serves both. A mixed
// state offers both directions rather than guessing which the reader meant.
export interface HalfAction {
    readonly command: DeviceSyncSwitch;
    readonly label: string;
    readonly hint: string;
}

export interface DeviceSwitch {
    readonly label: string;
    readonly state: HalfState;
    /** The state in one word, for the settled positions. */
    readonly word: string;
    /** What disagrees, when the pairings do; replaces the word rather than joining it. */
    readonly note: string | undefined;
    /** How much this switch touches: every label says "all" without saying all of what. */
    readonly scope: string;
    readonly actions: readonly HalfAction[];
}

const PAUSE: HalfAction = {
    command: `sync-pause`,
    label: `Pause all`,
    hint: `Stop moving files either way, for every sandbox this device syncs. Their ports keep being mirrored.`,
};
const RESUME: HalfAction = { command: `sync-resume`, label: `Resume all`, hint: `Start moving files again for every sandbox this device syncs.` };
const MIRROR_OFF: HalfAction = {
    command: `mirror-off`,
    label: `Stop all`,
    hint: `Take every paired sandbox's ports off this device's localhost. Files keep syncing.`,
};
const MIRROR_ON: HalfAction = { command: `mirror-on`, label: `Start all`, hint: `Put every paired sandbox's ports back on this device's localhost.` };

// A settled switch offers the way out; a mixed one offers both, rather than choosing for the reader.
const actionsFor = (position: HalfState, toOff: HalfAction, toOn: HalfAction): HalfAction[] =>
    position === `on` ? [toOff] : position === `off` ? [toOn] : [toOn, toOff];

// What a mixed half says, in the machine's own units ("2 of 3 paused").
const halfNote = (half: DeviceHalf, offWord: string): string | undefined =>
    half.state === `mixed` ? `${half.off} of ${half.total} ${offWord}` : undefined;

export const deviceSwitches = (row: DeviceRow): DeviceSwitch[] => {
    const switches: DeviceSwitch[] = [];
    const sync = syncHalf(row);
    if (switchable(row, sync)) {
        switches.push({
            label: `File syncing`,
            state: sync.state,
            word: sync.state === `off` ? `paused` : `on`,
            note: halfNote(sync, `paused`),
            scope: `all ${sync.total} sandboxes`,
            actions: actionsFor(sync.state, PAUSE, RESUME),
        });
    }
    const mirror = mirrorHalf(row);
    if (switchable(row, mirror)) {
        switches.push({
            label: `Port mirroring`,
            state: mirror.state,
            word: mirror.state === `off` ? `off` : `on`,
            note: halfNote(mirror, `off`),
            scope: `all ${mirror.total} sandboxes`,
            actions: actionsFor(mirror.state, MIRROR_OFF, MIRROR_ON),
        });
    }
    return switches;
};
