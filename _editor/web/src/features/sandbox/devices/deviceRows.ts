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
import type { IconName, StatusVariant, Tip } from "@intentic/ui";
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
import { t } from "@intentic/ui/i18n";

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
type DeviceStateCode = `live` | `attention` | `quiet` | `reconnecting` | `offline`;

const stateCode = (device: Device, readAt: number): DeviceStateCode => {
    // Said before the gap it is a case of: a socket dropped seconds ago is a machine on its way back, and calling
    // that offline is a verdict this row contradicts a second later.
    if (deviceReconnecting(device, readAt)) {
        return `reconnecting`;
    }
    if (device.gap !== undefined) {
        return device.gap === `offline` ? `offline` : `attention`;
    }
    if (deviceQuiet(device, readAt)) {
        return `quiet`;
    }
    return device.report?.agent.running === false || agentHalted(device) ? `attention` : `live`;
};

// The badge's word, built when read so it follows the language on screen.
const stateWord = (code: DeviceStateCode): string =>
    ({
        live: t(`sandbox.deviceRows.stateLive`),
        attention: t(`sandbox.deviceRows.stateAttention`),
        quiet: t(`sandbox.deviceRows.stateQuiet`),
        reconnecting: t(`sandbox.deviceRows.stateReconnecting`),
        offline: t(`sandbox.deviceRows.stateOffline`),
    })[code];

export const deviceState = (device: Device, readAt: number): string => stateWord(stateCode(device, readAt));

// Machines worth reading first: state leads, name breaks ties, so order only changes when a machine's state
// does. Live ranks above needs-attention, since a live card is the point of the board; a machine with several
// environments ranks by its best one, since that is the door that works.
const RANK: Record<DeviceStateCode, number> = { live: 0, attention: 1, quiet: 2, reconnecting: 3, offline: 4 };

// One word for the whole PC, so the masthead carries a verdict instead of restating the environment names that
// are the section under it; worst side wins, since each row below carries its own state.
export const machineState = (machine: MachineRow, readAt: number): { word: string; variant: StatusVariant } => {
    const states = machine.environments.map((environment) => ({
        word: deviceState(environment.device, readAt),
        variant: deviceTone(environment.device, readAt),
        rank: RANK[stateCode(environment.device, readAt)],
    }));
    const worst = states.toSorted((a, b) => b.rank - a.rank)[0];
    if (worst === undefined) {
        return { word: stateWord(`offline`), variant: `neutral` };
    }
    return { word: worst.word, variant: worst.variant };
};

// What the machine IS, in the quietest ink the masthead has: read once, mostly to tell two identically-named PCs
// apart. Every environment reports the same hardware, so it is taken from the first that describes itself; the
// hostname joins only when it differs from the name already above it.
export const machineHardware = (machine: MachineRow): string => {
    const described = machine.environments.find((environment) => environment.device.facts !== undefined)?.device;
    if (described === undefined) {
        return ``;
    }
    const hostname = described.report?.hostname;
    return [described.facts?.arch, hostname !== undefined && hostname.toLowerCase() !== machine.label.toLowerCase() ? hostname : undefined]
        .filter((part) => part !== undefined && part !== ``)
        .join(` · `);
};

const machineRank = (machine: MachineRow, readAt: number): number =>
    Math.min(...machine.environments.map((environment) => RANK[stateCode(environment.device, readAt)]));

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
        agent: agent === undefined ? undefined : { ...agent, stalled: agentHalted(device), ...(staleBuild === undefined ? {} : { staleBuild }) },
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

// The slug docker knows a sandbox's container by: the first label of its daemon's hostname, the rule the setup
// script names the container with and the launcher addresses it by. Undefined for a sandbox that has no address yet.
export const slugOfDaemonUrl = (daemonUrl: string | null | undefined): string | undefined => {
    if (daemonUrl === null || daemonUrl === undefined || !URL.canParse(daemonUrl)) {
        return undefined;
    }
    return new URL(daemonUrl).hostname.split(`.`)[0] || undefined;
};

// The account's own name for every container a machine lists, matched by slug. Docker knows only the container, so
// without this a row is titled by its synced folder (named once, at setup, and never again) or by its bare slug.
// The account's name wins over one the machine recorded, since a rename lands there first; a container this account
// cannot see keeps whatever it had. Devices with nothing to rename are returned as they came.
export const withSandboxNames = (devices: readonly Device[], account: readonly { name: string; daemonUrl: string | null }[]): Device[] => {
    const names = new Map<string, string>();
    for (const sandbox of account) {
        const slug = slugOfDaemonUrl(sandbox.daemonUrl);
        if (slug !== undefined && sandbox.name !== ``) {
            names.set(slug, sandbox.name);
        }
    }
    return devices.map((device) =>
        device.sandboxes?.some((sandbox) => names.has(sandbox.slug) && names.get(sandbox.slug) !== sandbox.name) === true
            ? {
                  ...device,
                  sandboxes: device.sandboxes.map((sandbox) => {
                      const name = names.get(sandbox.slug);
                      return name === undefined ? sandbox : { ...sandbox, name };
                  }),
              }
            : device,
    );
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

// A connected machine that answered but did not list its containers, carrying its own reason (`sandboxesUnread`): when no
// door lists a sandbox, the one that may well run it, and the honest thing for a card falling back to a command to name
// instead of "connect the computer it runs on" (2026-10-07). The first such door; undefined when none said why.
export const deviceNotListing = (devices: readonly Device[]): Device | undefined =>
    devices.find(
        (device) => device.hostId !== undefined && device.online === true && device.sandboxes === undefined && device.sandboxesUnread !== undefined,
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
export const pausable = (device: Device, group: DeviceSandboxGroup): boolean => commandable(device, group) && syncSessionLive(group.folder);

// WHAT "REMOVE FROM THIS DEVICE" TAKES, per row. Two independent halves, because a row can be either or both: the
// container this machine's docker holds, and the enrollment its agent keeps. Stated as a pair rather than a boolean
// so the confirmation can name each consequence separately — one ends a sandbox, the other only stops it being
// copied here — and so a row that is neither draws no verb at all.
export interface RowRemoval {
    /** The container goes, with its files and its history; `ic sandbox restore` brings it back for a week. */
    readonly container: boolean;
    /** File syncing and port mirroring stop; the folder on the device is left exactly where it is. */
    readonly pairing: boolean;
}

export const rowRemoval = (machine: MachineRow, group: DeviceSandboxGroup): RowRemoval => {
    const manager = managerOf(machine);
    const owner = folderOwner(machine, group);
    return {
        container: manager !== undefined && manageable(manager.device, group),
        pairing: owner !== undefined && commandable(owner.device, group),
    };
};

// Whether this machine holds anything of this sandbox that a click here could let go of. False on a row the machine
// only knows about — a port reading with no container and no pairing behind it.
export const removableHere = (machine: MachineRow, group: DeviceSandboxGroup): boolean => {
    const removal = rowRemoval(machine, group);
    return removal.container || removal.pairing;
};

// WHAT A SELECTION CAN HAVE DONE TO IT. The list is managed by ticking rows and choosing a verb for all of them, so
// each verb states which rows it applies to and the bar offers only the verbs something ticked can take — a Stop over
// three rows of which one is running stops that one, and says so, rather than refusing the other two one by one.
// The same floors as each row's own menu: a container verb needs a reachable door onto a real container, and Remove
// needs something this machine holds (rowRemoval).
export const BATCH_VERBS = [`start`, `stop`, `restart`, `update`, `remove`] as const;
export type BatchVerb = (typeof BATCH_VERBS)[number];

export const batchEligible = (machine: MachineRow, group: DeviceSandboxGroup, verb: BatchVerb): boolean => {
    if (verb === `remove`) {
        return removableHere(machine, group);
    }
    const manager = managerOf(machine);
    if (manager === undefined || !manageable(manager.device, group)) {
        return false;
    }
    const running = group.sandbox?.running === true;
    return verb === `start` ? !running : verb === `update` ? true : running;
};

// The rows a batch may take. The sandbox serving the page is excluded on purpose: stopping, restarting, updating or
// removing it takes down the connection running the loop, abandoning every row still queued behind it. Its own row
// keeps its menu, whose every severing verb warns about exactly that.
export const batchable = (machine: MachineRow, ownSlug: string | undefined): DeviceSandboxGroup[] =>
    machine.groups.filter((group) => !isSelfMachine(machine, group, ownSlug) && BATCH_VERBS.some((verb) => batchEligible(machine, group, verb)));

/** One verb the bar offers, and exactly the ticked rows it would act on. */
export interface BatchAction {
    readonly verb: BatchVerb;
    readonly groups: readonly DeviceSandboxGroup[];
}

// Only the verbs at least one ticked row can take, in the menu's own reading order with Remove last.
export const batchActions = (machine: MachineRow, groups: readonly DeviceSandboxGroup[]): BatchAction[] =>
    BATCH_VERBS.map((verb) => ({ verb, groups: groups.filter((group) => batchEligible(machine, group, verb)) })).filter(
        (action) => action.groups.length > 0,
    );

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
    ...(row.chip === undefined ? [] : [t(`sandbox.deviceRows.agentVersion`, { version: row.chip.version })]),
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

export const mirrorHalf = (row: DeviceRow): DeviceHalf =>
    halfOf(
        row.groups.map((group) => group.folder),
        mirroringOff,
    );

// Offered under the same three conditions as the per-pairing buttons, plus more than one pairing for that
// half: over a single pairing this would be that row's own button wearing a wider, scarier label.
const switchable = (row: DeviceRow, half: DeviceHalf): boolean =>
    row.device.hostId !== undefined && row.device.online === true && row.device.gap === undefined && half.total > 1;

// Both halves are the same shape (a glyph, a state, one sentence, one or two commands), so one table serves both. A
// mixed state offers both directions rather than guessing which the reader meant.
export interface HalfAction {
    readonly command: DeviceSyncSwitch;
    readonly label: string;
    /** Absent where the label already says it all. */
    readonly hint?: Tip | string;
    /** What the button leads with, so a pause reads as a pause before its word does. */
    readonly icon: IconName;
}

export interface DeviceSwitch {
    readonly kind: `sync` | `mirror`;
    readonly label: string;
    /** The half's own mark, the lead of its row. */
    readonly icon: IconName;
    readonly state: HalfState;
    // The position and how much of the machine it covers, as ONE sentence ("Paused for 6 of 8 sandboxes"). The row
    // used to say it in three loose pieces — a word, a tinted "6 of 8 paused" and "all 8 sandboxes" — that each read
    // as a label of its own, with the paused count tinted like a healthy one.
    readonly summary: string;
    readonly actions: readonly HalfAction[];
    /** The counts the summary is made of, for a caller that adds several sides of one machine together. */
    readonly off: number;
    readonly total: number;
}

const pause = (): HalfAction => ({
    command: `sync-pause`,
    label: t(`sandbox.deviceRows.pauseAll`),
    hint: { title: t(`sandbox.words.filesOnly`), note: t(`sandbox.words.portsStayMirrored`) },
    icon: `pause`,
});
const resume = (): HalfAction => ({
    command: `sync-resume`,
    label: t(`sandbox.deviceRows.resumeAll`),
    icon: `play`,
});
// "Turn … off", never "Stop all": on a list whose rows carry a container's own Stop, a bare Stop reads as stopping
// the sandboxes, when all this does is take their ports off this machine's localhost.
const mirrorOff = (): HalfAction => ({
    command: `mirror-off`,
    label: t(`sandbox.deviceRows.turnAllOff`),
    hint: { title: t(`sandbox.words.offLocalhost`), note: t(`sandbox.words.filesKeepSyncing`) },
    icon: `eye-slash`,
});
const mirrorOn = (): HalfAction => ({
    command: `mirror-on`,
    label: t(`sandbox.deviceRows.turnAllOn`),
    hint: t(`sandbox.words.ontoLocalhost`),
    icon: `eye`,
});

// A settled switch offers the way out; a mixed one offers both, rather than choosing for the reader.
const actionsFor = (position: HalfState, toOff: HalfAction, toOn: HalfAction): HalfAction[] =>
    position === `on` ? [toOff] : position === `off` ? [toOn] : [toOn, toOff];

// Counted in the machine's own units. Never over one pairing (see `switchable`), so the noun is always plural.
const syncSummary = ({ state, off, total }: DeviceHalf): string =>
    state === `on`
        ? t(`sandbox.deviceRows.onForAll`, { total })
        : state === `off`
          ? t(`sandbox.deviceRows.pausedForAll`, { total })
          : t(`sandbox.deviceRows.pausedForSome`, { off, total });

const mirrorSummary = ({ state, off, total }: DeviceHalf): string =>
    state === `on`
        ? t(`sandbox.deviceRows.onForAll`, { total })
        : state === `off`
          ? t(`sandbox.deviceRows.offForAll`, { total })
          : t(`sandbox.deviceRows.offForSome`, { off, total });

export const deviceSwitches = (row: DeviceRow): DeviceSwitch[] => {
    const switches: DeviceSwitch[] = [];
    const sync = syncHalf(row);
    if (switchable(row, sync)) {
        switches.push({
            kind: `sync`,
            label: t(`sandbox.deviceRows.fileSyncing`),
            icon: `sync`,
            state: sync.state,
            summary: syncSummary(sync),
            actions: actionsFor(sync.state, pause(), resume()),
            off: sync.off,
            total: sync.total,
        });
    }
    const mirror = mirrorHalf(row);
    if (switchable(row, mirror)) {
        switches.push({
            kind: `mirror`,
            label: t(`sandbox.deviceRows.portMirroring`),
            icon: `ports`,
            state: mirror.state,
            summary: mirrorSummary(mirror),
            actions: actionsFor(mirror.state, mirrorOff(), mirrorOn()),
            off: mirror.off,
            total: mirror.total,
        });
    }
    return switches;
};

// THE MACHINE-WIDE SWITCHES AS TWO BUTTONS IN THE SANDBOX LIST'S HEADER, one per half, whatever number of sides the PC
// has. They used to be a row per half per side, each with its own "Pause all" / "Turn all off": four rows and seven
// buttons with repeated labels over a two-sided PC's list before its first sandbox. Now the button says where the half
// stands in a few words, added up over every side, and its menu holds the verbs, each naming its side where there is
// more than one.
export interface SwitchMenuEntry {
    readonly environment: DeviceRow;
    readonly half: DeviceSwitch;
}

export interface SwitchMenu {
    readonly kind: DeviceSwitch[`kind`];
    readonly icon: IconName;
    readonly label: string;
    /** Where the half stands across the machine, short enough for a button. */
    readonly state: string;
    /** Whether that is news: a half partly or wholly off reads in the warning's ink. */
    readonly settled: boolean;
    readonly entries: readonly SwitchMenuEntry[];
}

const shortState = (kind: DeviceSwitch[`kind`], off: number, total: number): string => {
    if (off === 0) {
        return kind === `sync` ? t(`sandbox.deviceRows.syncingShort`) : t(`sandbox.deviceRows.onShort`);
    }
    if (off === total) {
        return kind === `sync` ? t(`sandbox.deviceRows.pausedShort`) : t(`sandbox.deviceRows.offShort`);
    }
    return kind === `sync` ? t(`sandbox.deviceRows.pausedSomeShort`, { off, total }) : t(`sandbox.deviceRows.offSomeShort`, { off, total });
};

export const switchMenus = (environments: readonly DeviceRow[]): SwitchMenu[] => {
    const entries = environments.flatMap((environment) => deviceSwitches(environment).map((half): SwitchMenuEntry => ({ environment, half })));
    return ([`sync`, `mirror`] as const).flatMap((kind): SwitchMenu[] => {
        const mine = entries.filter((entry) => entry.half.kind === kind);
        const first = mine[0];
        if (first === undefined) {
            return [];
        }
        const off = mine.reduce((sum, entry) => sum + entry.half.off, 0);
        const total = mine.reduce((sum, entry) => sum + entry.half.total, 0);
        return [
            {
                kind,
                icon: first.half.icon,
                label: kind === `sync` ? t(`sandbox.deviceRows.files`) : t(`sandbox.deviceRows.ports`),
                state: shortState(kind, off, total),
                settled: off === 0,
                entries: mine,
            },
        ];
    });
};
