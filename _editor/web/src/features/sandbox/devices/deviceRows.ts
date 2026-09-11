import { agentBuildSkew, type Device, type DeviceAgent, type DeviceSyncSwitch } from "@intentic/sandbox-contract";
import type { StatusVariant, TallyItem } from "@intentic/ui";
import {
    type DeviceFolderRow,
    type DeviceSandboxGroup,
    groupNeedsAttention,
    groupSummary,
    isSameSandbox,
    mirroringOff,
    sandboxGroups,
} from "@intentic/ui/device";
import { type AgentChip, agentChip, agentHalted, deviceDoors, deviceQuiet, machineWarnings, osLabel } from "./deviceFacts";

// One machine as the board and the device page both read it: its state in one word and one colour, its
// sandboxes folded into groups, and the agent verdicts a render needs. Pure throughout, so the same rules
// can be checked without mounting anything (deviceRows.test.ts).

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
    if (device.gap !== undefined) {
        return device.gap === `offline` ? `offline` : `needs attention`;
    }
    if (deviceQuiet(device, readAt)) {
        return `gone quiet`;
    }
    return device.report?.agent.running === false || agentHalted(device) ? `needs attention` : `live`;
};

// Machines worth reading first: state leads, name breaks ties, so order only changes when a machine's state
// does. Live ranks above needs-attention, since a live card is the point of the board.
const RANK: Record<string, number> = { live: 0, "needs attention": 1, "gone quiet": 2, offline: 3 };

export const sortDevices = (devices: readonly Device[], readAt: number): Device[] =>
    devices.toSorted((a, b) => (RANK[deviceState(a, readAt)] ?? 9) - (RANK[deviceState(b, readAt)] ?? 9) || a.label.localeCompare(b.label));

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
// warning both screens draw.
const groupsOf = (device: Device): DeviceSandboxGroup[] =>
    device.report === undefined ? [] : sandboxGroups(device.report.pairings, device.report.ports, device.report.sandboxes);

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

export const deviceRows = (devices: readonly Device[], latest: string | undefined, readAt: number): DeviceRow[] =>
    sortDevices(devices, readAt).map((device) => deviceRow(device, latest));

// The sandbox you're looking at, matched by its container slug on the machine. Both sides must be known:
// comparing two optionals let a pairing with no container on an unknown-URL sandbox match
// `undefined === undefined` and falsely claim to be the one in use.
export const isSelf = (device: Device, group: DeviceSandboxGroup, ownSlug: string | undefined): boolean =>
    device.hostId !== undefined && ownSlug !== undefined && group.sandbox?.slug === ownSlug;

export const selfGroup = (row: DeviceRow, ownSlug: string | undefined): DeviceSandboxGroup | undefined =>
    row.groups.find((group) => isSelf(row.device, group, ownSlug));

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

// Offered only where there's a file sync to pause; a mirror-only enrollment has no session for it.
export const pausable = (device: Device, group: DeviceSandboxGroup): boolean =>
    commandable(device, group) && group.folder?.mode === `sync`;

// A conflict has no switch: choosing between two edited copies is judgement per file, so the control is a
// turn an agent can run against both ends, not a one-click winner.
export const fixable = (device: Device, group: DeviceSandboxGroup): boolean =>
    commandable(device, group) && (group.folder?.conflicts ?? 0) > 0;

const has = (needle: string, ...fields: (string | undefined)[]): boolean =>
    fields.some((field) => field !== undefined && field.toLowerCase().includes(needle));

// Port numbers are matched too: "which machine has 8788" is the single most common reason to open this tab.
export const groupMatches = (group: DeviceSandboxGroup, needle: string): boolean =>
    has(needle, group.title, group.subtitle, group.sandboxId, group.sandbox?.slug, group.sandbox?.image, group.folder?.localDir) ||
    group.ports.some((port) => String(port.port).includes(needle));

export const rowMatches = (row: DeviceRow, needle: string): boolean =>
    has(needle, row.device.label, row.device.key, osLabel(row.device), row.device.hostId, row.device.report?.hostname) ||
    row.groups.some((group) => groupMatches(group, needle));

// Shown only once there's enough to search: a filter over two machines costs more attention than it saves.
const FILTER_FLOOR = 3;

export const showFilter = (rows: readonly DeviceRow[]): boolean =>
    rows.length > 2 || rows.reduce((total, row) => total + row.groups.length, 0) > FILTER_FLOOR;

// The orientation line, answered before a card is parsed: one measure (sandboxes) split by state.
// `running` stays visible even at zero so the tally never renders as nothing.
export const deviceTally = (rows: readonly DeviceRow[]): TallyItem[] => {
    const groups = rows.flatMap((row) => row.groups);
    return [
        { label: `running`, value: groups.filter((group) => group.sandbox?.running === true).length, variant: `success`, always: true },
        { label: `stopped`, value: groups.filter((group) => group.sandbox?.running === false).length, variant: `neutral` },
        { label: `need attention`, value: groups.filter(groupNeedsAttention).length, variant: `warning` },
    ];
};

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

export interface BoardBody {
    /** The doors this sandbox reaches the machine through, then the build its agent serves. */
    readonly doors: readonly string[];
    readonly lines: readonly BoardLine[];
    /** Sandboxes those lines do not account for, counted against what the machine reported. */
    readonly more: number;
    /** What is wrong with the machine itself; each line above carries its own. */
    readonly warnings: readonly string[];
}

// While the filter is active every matching sandbox is drawn, however many: a port search whose answer was
// the fourth line would otherwise land on a card that doesn't show it.
export const boardBody = (row: DeviceRow, needle: string, ownSlug: string | undefined, readAt: number): BoardBody => {
    const matched = needle === `` ? row.groups : row.groups.filter((group) => groupMatches(group, needle));
    const shown = needle === `` ? matched.slice(0, BOARD_LINES_MAX) : matched;
    return {
        doors: [...deviceDoors(row.device).map((door) => door.name), ...(row.chip === undefined ? [] : [`agent ${row.chip.version}`])],
        lines: shown.map((group) => {
            const summary = groupSummary(group);
            return {
                sandboxId: group.sandboxId,
                title: group.title,
                running: group.sandbox?.running,
                facts: summary.facts,
                warnings: summary.warnings,
                self: isSelf(row.device, group, ownSlug),
            };
        }),
        more: matched.length - shown.length,
        warnings: machineWarnings(row.device, readAt),
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
