import type { Device } from "@intentic/sandbox-contract";
import type { IconName } from "@intentic/ui";
import type { NoticeTone } from "@intentic/ui/notice";
import { timeAgo } from "@intentic/ui/format";
import { deviceQuiet, deviceReconnecting, type ManageBlock } from "../deviceFacts";
import type { DeviceRow } from "../deviceRows";
import { t } from "@intentic/ui/i18n";

// Everything a device wants from the reader, as one ordered list: the gap that stops it answering, the age
// of the reading, and the switch standing between its sandboxes and their buttons. A healthy machine yields
// none of it, which is nearly all of them.

// The agent is deliberately absent: its state and its two verbs are one object with one home (deviceAgent.ts),
// rather than a sentence here and a version strip further down the page.

// A capability card to open. Kept as data rather than a route so this module stays free of the router.
export interface DeviceCardFix {
    readonly kind: `card`;
    readonly label: string;
    readonly card: string;
    /** Present to edit an existing connection's own form; absent to open the card that adds one. */
    readonly connection?: string;
}

// Mints this machine a fresh pairing command, the same one its capability card hands out: the only remedy left
// once the machine stops answering, since every other button here travels over the connection it isn't holding.
export interface DeviceConnectFix {
    readonly kind: `connect`;
    readonly label: string;
    readonly hint: string;
}

export type DeviceFix = DeviceCardFix | DeviceConnectFix;

export interface DeviceConcern {
    readonly key: string;
    readonly tone: NoticeTone;
    // The subject in one glyph, not the tone's own exclamation mark: what a reader sorts these by is sleep from
    // permissions from age, which the rank alone cannot tell them.
    readonly icon: IconName;
    readonly text: string;
    /** A command to type on that device, where the fix is one rather than a click; kept unwrapped. */
    readonly command?: string;
    readonly fix?: DeviceFix;
}

// Each gap is a different errand and gets its own sentence; `scope-off` names the switch to flip, since
// that's the only one closed in a single click.
const GAP_TEXT: Record<NonNullable<Device[`gap`]>, string> = {
    // The only gap with nothing on the other end to ask, so it names both ways back in: the machine's own agent
    // command for one that is merely awake with its loop down, and, on the button, a fresh pairing.
    offline: `Asleep or offline. A machine that wakes dials back in by itself; one that is already awake needs its agent started.`,
    // Its containers are listed regardless (they answer to "Manage sandboxes on this device"), so this names what is
    // actually missing rather than claiming the machine is unreadable.
    "scope-off": `"Run commands" is off in this device's capability card, so it won't describe itself: no folders, no mirrored ports, and no word on whether its agent is alive. Turn it on to see those.`,
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

// What the gap IS, at a glance: a sleeping machine, a switch that is off, a missing install, a silence.
const GAP_ICON: Record<NonNullable<Device[`gap`]>, IconName> = {
    offline: `moon`,
    "scope-off": `lock`,
    "no-agent": `desktop`,
    unreported: `question-circle`,
};

// Each block is a different errand, so each gets its own sentence.
const BLOCK_TEXT: Record<ManageBlock[`kind`], string> = {
    connect: `Desktop sync carries folders and ports, never containers, so its sandboxes can't be started, updated or removed from here. Connect it as a device for the same buttons the desktop app's own window has.`,
    // Every button on this page needs the device's own outbound socket; a machine can sync files flawlessly
    // with that socket down.
    offline: `This device is connected but isn't reachable right now — asleep, off the network, or its agent isn't running — so its sandboxes can't be started, updated or removed from here.`,
    "sandboxes-off": `Turn on "Manage sandboxes on this device" in this device's capability card to use the buttons below.`,
};

// Same vocabulary as the gaps above: a machine to connect, a machine asleep, a switch that is off.
const BLOCK_ICON: Record<ManageBlock[`kind`], IconName> = {
    connect: `desktop`,
    offline: `moon`,
    "sandboxes-off": `lock`,
};

// What a machine that is awake with its loop down needs typed on it. One constant for the two sentences that can
// say it — the gap (nothing was ever heard) and the block (a report is held, the device door is shut) — which are
// mutually exclusive by construction, so a reader never sees it twice.
const AGENT_START = `intentic-machine run`;

// Set in mono like every other command this view names, rather than left as bare text inside a sentence.
const GAP_COMMAND: Partial<Record<NonNullable<Device[`gap`]>, string>> = { offline: AGENT_START };
const BLOCK_COMMAND: Partial<Record<ManageBlock[`kind`], string>> = { offline: AGENT_START };

// Only the kinds a capability card can close; an offline device's card holds no switch that would bring it back,
// so its button mints a pairing instead (RECONNECT below).
const BLOCK_ACTION: Partial<Record<ManageBlock[`kind`], string>> = {
    connect: `Connect this device`,
    "sandboxes-off": `Open its permissions`,
};

// The one remedy that works on a machine holding no connection: the same fresh, single-use command its capability
// card hands out, which installs or re-enrolls the agent and registers it to come back after a reboot.
const reconnect = (): DeviceConnectFix => ({
    kind: `connect`,
    label: t(`sandbox.deviceAttention.reconnect`),
    hint: t(`sandbox.deviceAttention.handsFreshOneTime`),
});

// `connect` opens the card that adds a device; two more open the existing connection's own form; `offline` has no
// card worth opening.
const blockFix = (block: ManageBlock, reconnectable: boolean): DeviceFix | undefined => {
    if (block.kind === `offline`) {
        return reconnectable ? reconnect() : undefined;
    }
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

// Why the machine isn't answering, and the two ways back: the command for a machine whose loop alone is down,
// and the pairing for one whose agent is gone. Only `offline` carries either — every other gap is a machine that
// answers, whose own sentence already names its errand.
const gapConcern = (device: Device, reconnectable: boolean): DeviceConcern | undefined => {
    if (device.gap === undefined) {
        return undefined;
    }
    const command = GAP_COMMAND[device.gap];
    return {
        key: `gap`,
        tone: GAP_TONE[device.gap],
        icon: GAP_ICON[device.gap],
        text: GAP_TEXT[device.gap],
        ...(command === undefined ? {} : { command }),
        ...(device.gap === `offline` && reconnectable ? { fix: reconnect() } : {}),
    };
};

// The switch standing between this machine's sandboxes and their buttons, and whichever remedy closes it: a
// capability card for the three that are permissions, the machine's own two ways back for the one that isn't.
const blockConcern = (block: ManageBlock, reconnectable: boolean): DeviceConcern => {
    const fix = blockFix(block, reconnectable);
    const command = BLOCK_COMMAND[block.kind];
    return {
        key: `block`,
        tone: `info`,
        icon: BLOCK_ICON[block.kind],
        text: BLOCK_TEXT[block.kind],
        ...(command === undefined ? {} : { command }),
        ...(fix === undefined ? {} : { fix }),
    };
};

// The block alone, for a machine whose sandboxes are listed once under several environments: it is about the door
// the buttons go through, not about any one environment, so it is drawn beside the list rather than under a row.
export const blockAttention = (
    row: DeviceRow,
    { block, canPair }: { block: ManageBlock | undefined; canPair: boolean },
): DeviceConcern | undefined => (block === undefined ? undefined : blockConcern(block, canPair && row.device.hostId !== undefined));

export const deviceAttention = (
    row: DeviceRow,
    {
        block,
        readAt,
        canPair,
    }: {
        block: ManageBlock | undefined;
        readAt: number;
        /** Whether this reader may mint this machine a pairing: the daemon's own floor for it is the owner. */
        canPair: boolean;
    },
): readonly DeviceConcern[] => {
    const concerns: DeviceConcern[] = [];
    const { device } = row;
    // Offered wherever the silence is explained, since minting is the one thing that works without the machine:
    // a row with no device connection has nothing to re-pair, and a member may not mint at all.
    const reconnectable = canPair && device.hostId !== undefined;
    // Whether the machine answers at all comes first: it decides what the rest of the page is worth. A socket
    // dropped seconds ago is exempt, since every agent restart drops one and the machine is dialling back as this
    // is read; the state word carries it alone until the window is out.
    const gap = deviceReconnecting(device, readAt) ? undefined : gapConcern(device, reconnectable);
    if (gap !== undefined) {
        concerns.push(gap);
    }
    // A report is a snapshot of a device that may since have closed its lid, so its age qualifies everything
    // under it. Aged against the reading, so this is what the machine was doing when we heard from it, not how long
    // a cached page has been open.
    if (deviceQuiet(device, readAt)) {
        concerns.push({
            key: `stale`,
            tone: `warning`,
            icon: `clock`,
            // `deviceQuiet` is false without a report, so the timestamp is there whenever this line is.
            text: `Last heard from ${timeAgo(device.report?.capturedAt ?? readAt, { now: readAt })}. What follows is what it looked like then.`,
        });
    }
    // Last, and quietest: nothing here is broken, it only explains an absence of buttons.
    if (block !== undefined) {
        concerns.push(blockConcern(block, reconnectable));
    }
    return concerns;
};
