import type { Device, DeviceAgentOp } from "@intentic/sandbox-contract";
import type { NoticeTone } from "@intentic/ui/notice";
import { timeAgo } from "@intentic/ui/format";
import { agentBehind, deviceQuiet, type ManageBlock } from "./deviceFacts";
import type { DeviceRow } from "./deviceRows";

// Everything a device wants from the reader, as one ordered list: the gap that stops it answering, the age
// of the reading, its agent, and the switch standing between its sandboxes and their buttons. A healthy
// machine yields none of it, which is nearly all of them.

// A capability card to open, or an op to run on the machine from this page. Kept as data rather than a
// route so this module stays free of the router.
export interface DeviceCardFix {
    readonly kind: `card`;
    readonly label: string;
    readonly card: string;
    /** Present to edit an existing connection's own form; absent to open the card that adds one. */
    readonly connection?: string;
}

export interface DeviceAgentFix {
    readonly kind: `agent`;
    readonly label: string;
    readonly op: DeviceAgentOp;
    readonly hint: string;
}

export type DeviceFix = DeviceCardFix | DeviceAgentFix;

export interface DeviceConcern {
    readonly key: string;
    readonly tone: NoticeTone;
    readonly text: string;
    /** A command to type on that device, where the fix is one rather than a click; kept unwrapped. */
    readonly command?: string;
    readonly fix?: DeviceFix;
}

// Each gap is a different errand and gets its own sentence; `scope-off` names the switch to flip, since
// that's the only one closed in a single click.
const GAP_TEXT: Record<NonNullable<Device[`gap`]>, string> = {
    offline: `Asleep or offline.`,
    "scope-off": `Turn on "Run commands" in this device's capability card to see what it is running.`,
    "no-agent": `Reachable, but it has no agent, so nothing here knows its folders or ports.`,
    unreported: `Enrolled, but it hasn't reported yet. An agent from before machine reports never will. Re-run its install to update it.`,
};

// An asleep laptop is a state, not a fault; the other three are something the reader can close.
const GAP_TONE: Record<NonNullable<Device[`gap`]>, NoticeTone> = {
    offline: `info`,
    "scope-off": `warning`,
    "no-agent": `warning`,
    unreported: `warning`,
};

// Each block is a different errand, so each gets its own sentence.
const BLOCK_TEXT: Record<ManageBlock[`kind`], string> = {
    connect: `Desktop sync carries folders and ports, never containers, so its sandboxes can't be started, updated or removed from here. Connect it as a device for the same buttons the desktop app's own window has.`,
    // Every button on this page needs the device's own outbound socket; a machine can sync files flawlessly
    // with that socket down.
    offline: `This device is connected but isn't reachable right now — asleep, off the network, or its agent isn't running — so its sandboxes can't be started, updated or removed from here.`,
    "sandboxes-off": `Turn on "Manage sandboxes on this device" in this device's capability card to use the buttons below.`,
    "remove-off": `Removing a sandbox needs "Remove sandboxes from this device" on this device's capability card. Everything else below already works.`,
};

// Set in mono like every other command this view names, rather than left as bare text inside a sentence.
const BLOCK_COMMAND: Partial<Record<ManageBlock[`kind`], string>> = { offline: `intentic-machine run` };

// Only the kinds a click can close; an offline device gets no button, since its fix is a command on that
// machine, not a capability card.
const BLOCK_ACTION: Partial<Record<ManageBlock[`kind`], string>> = {
    connect: `Connect this device`,
    "sandboxes-off": `Open its permissions`,
    "remove-off": `Open its permissions`,
};

// `connect` opens the card that adds a device; the other two open the existing connection's own form.
const blockFix = (block: ManageBlock): DeviceFix | undefined => {
    const label = BLOCK_ACTION[block.kind];
    // No card for this platform (a Mac, an unrecognised slug) means nowhere to send anyone: the sentence
    // runs alone rather than beside a dead control.
    if (label === undefined || block.card === undefined) {
        return undefined;
    }
    return {
        kind: `card`,
        label,
        card: block.card,
        ...(block.kind === `connect` ? {} : { connection: block.connection }),
    };
};

const RESTART: DeviceAgentFix = {
    kind: `agent`,
    label: `Restart agent`,
    op: `restart`,
    hint: `Stop and start this device's agent loop. Nothing is downloaded, and the build already installed there is the one that comes up.`,
};

const UPGRADE: DeviceAgentFix = {
    kind: `agent`,
    label: `Update agent`,
    op: `upgrade`,
    hint: `Download and install the current agent on this device, then restart its loop. Its folders, pairings and mirrored ports are untouched.`,
};

// Every button here travels over the device's own outbound socket, so a machine that isn't holding one gets
// the sentence without the control.
const reachable = (device: Device): boolean => device.hostId !== undefined && device.online === true && device.gap === undefined;

// One restart concern at most, naming the worst of the three reasons: two sentences each carrying the same
// button would ask twice for one click.
const restartConcern = (row: DeviceRow): DeviceConcern | undefined => {
    const agent = row.agent;
    if (agent === undefined) {
        return undefined;
    }
    const text = !agent.running
        ? `Its agent isn't running, so nothing is reaching this device's folders or ports.`
        : agent.stalled
          ? `Its agent is alive but has stopped making rounds, so the folders and ports below may be out of date.`
          : agent.staleBuild === undefined
            ? undefined
            : agent.staleBuild.running === undefined
              ? `It is serving a build older than the ${agent.staleBuild.installed} installed here: a loop keeps the build it started with until it restarts.`
              : `It is serving agent ${agent.staleBuild.running} while ${agent.staleBuild.installed} is installed here: a loop keeps the build it started with until it restarts.`;
    if (text === undefined) {
        return undefined;
    }
    return { key: `agent-restart`, tone: `warning`, text, ...(reachable(row.device) ? { fix: RESTART } : {}) };
};

// Judged on the installed build, since that's what an update downloads over; a device whose only problem is
// a stale loop is restartConcern's, not this one's.
const updateConcern = (row: DeviceRow, latest: string | undefined): DeviceConcern | undefined => {
    if (!agentBehind(row.device, latest) || latest === undefined) {
        return undefined;
    }
    const held = row.device.report?.agent.installed ?? row.chip?.version;
    return {
        key: `agent-update`,
        tone: `info`,
        text: held === undefined ? `Agent ${latest} has been published.` : `Agent ${latest} has been published; this device has ${held}.`,
        ...(reachable(row.device) ? { fix: UPGRADE } : {}),
    };
};

export const deviceAttention = (
    row: DeviceRow,
    { block, latest, readAt }: { block: ManageBlock | undefined; latest: string | undefined; readAt: number },
): readonly DeviceConcern[] => {
    const concerns: DeviceConcern[] = [];
    const { device } = row;
    // Whether the machine answers at all comes first: it decides what the rest of the page is worth.
    if (device.gap !== undefined) {
        concerns.push({ key: `gap`, tone: GAP_TONE[device.gap], text: GAP_TEXT[device.gap] });
    }
    // A report is a snapshot of a device that may since have closed its lid, so its age qualifies everything
    // under it. Aged against the reading, so this is what the machine was doing when we heard from it, not how long
    // a cached page has been open.
    if (deviceQuiet(device, readAt)) {
        concerns.push({
            key: `stale`,
            tone: `warning`,
            // `deviceQuiet` is false without a report, so the timestamp is there whenever this line is.
            text: `Last heard from ${timeAgo(device.report?.capturedAt ?? readAt, { now: readAt })}. What follows is what it looked like then.`,
        });
    }
    const restart = restartConcern(row);
    if (restart !== undefined) {
        concerns.push(restart);
    }
    // Both can be true at once (replaced but not restarted, and something newer published), so neither
    // hides the other.
    const update = updateConcern(row, latest);
    if (update !== undefined) {
        concerns.push(update);
    }
    // Last, and quietest: nothing here is broken, it only explains an absence of buttons.
    if (block !== undefined) {
        const fix = blockFix(block);
        const command = BLOCK_COMMAND[block.kind];
        concerns.push({
            key: `block`,
            tone: `info`,
            text: BLOCK_TEXT[block.kind],
            ...(command === undefined ? {} : { command }),
            ...(fix === undefined ? {} : { fix }),
        });
    }
    return concerns;
};
