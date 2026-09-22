import type { Device, DeviceAgentOp } from "@intentic/sandbox-contract";
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

// One of the agent's own verbs, run over the socket that machine is already holding: a button here, rather than a
// command the reader has to walk to the machine and type. Carries the op alone — which machine it goes to is the row's,
// and the row is what draws this.
export interface DeviceAgentFix {
    readonly kind: `agent`;
    readonly label: string;
    readonly hint: string;
    readonly op: DeviceAgentOp;
}

export type DeviceFix = DeviceCardFix | DeviceConnectFix | DeviceAgentFix;

export interface DeviceConcern {
    readonly key: string;
    readonly tone: NoticeTone;
    // The subject in one glyph, not the tone's own exclamation mark: what a reader sorts these by is sleep from
    // permissions from age, which the rank alone cannot tell them.
    readonly icon: IconName;
    /** The errand alone: the state word is the badge's, and repeating it here is how this strip grew to four lines. */
    readonly text: string;
    /** Why, for a reader who wants it; never something they must read to act. */
    readonly hint?: string;
    /** A command to type on that device, where the fix is one rather than a click; kept unwrapped. */
    readonly command?: string;
    readonly fix?: DeviceFix;
}

// Each gap is a different errand and gets its own sentence; `scope-off` names the switch to flip, since
// that's the only one closed in a single click.
const GAP_TEXT: Record<NonNullable<Device[`gap`]>, string> = {
    // The only gap with nothing on the other end to ask, so it names both ways back in: the machine's own agent
    // command for one that is merely awake with its loop down, and, on the button, a fresh pairing.
    offline: `A machine that wakes dials back in by itself.`,
    // Its containers are listed regardless (they answer to "Manage sandboxes on this device"), so this names what is
    // actually missing rather than claiming the machine is unreadable.
    "scope-off": `Turn on "Run commands" in its capability card to see its folders, ports and agent.`,
    unreported: `Its agent has never described this machine. Update it.`,
};

// The clause each sentence above was cut down from, on hover: what nobody has to read to act.
const GAP_HINT: Record<NonNullable<Device[`gap`]>, string> = {
    offline: `Asleep, off the network, or its agent isn't running. Reconnect mints a fresh pairing command, for a machine whose agent is gone rather than merely stopped.`,
    "scope-off": `Without it the machine won't describe itself: no folders, no mirrored ports, and no word on whether its agent is alive. Its containers are listed regardless — those answer to a different switch.`,
    unreported: `An agent from before machine reports never will. Update agent replaces it over the connection; a machine that only syncs gets the new one by re-running its install.`,
};

// An asleep laptop is a state, not a fault; the other three are something the reader can close.
const GAP_TONE: Record<NonNullable<Device[`gap`]>, NoticeTone> = {
    offline: `info`,
    "scope-off": `warning`,
    unreported: `warning`,
};

// What the gap IS, at a glance: a sleeping machine, a switch that is off, a silence.
const GAP_ICON: Record<NonNullable<Device[`gap`]>, IconName> = {
    offline: `moon`,
    "scope-off": `lock`,
    unreported: `question-circle`,
};

// Each block is a different errand, so each gets its own sentence.
const BLOCK_TEXT: Record<ManageBlock[`kind`], string> = {
    connect: `Connect it as a device to start, update and remove its sandboxes from here.`,
    // Every button on this page needs the device's own outbound socket; a machine can sync files flawlessly
    // with that socket down.
    offline: `Not reachable, so its sandboxes can't be started, updated or removed from here.`,
    "sandboxes-off": `Turn on "Manage sandboxes on this device" in this device's capability card to use the buttons below.`,
};

const BLOCK_HINT: Record<ManageBlock[`kind`], string> = {
    connect: `Desktop sync carries folders and ports, never containers. Connecting it as a device gives the same buttons the desktop app's own window has.`,
    offline: `Asleep, off the network, or its agent isn't running. Every button here travels over the device's own outbound connection, which a machine can have down while its files sync flawlessly.`,
    "sandboxes-off": `Every button under the sandbox list is refused until it is on.`,
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
        hint: GAP_HINT[device.gap],
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
        hint: BLOCK_HINT[block.kind],
        ...(command === undefined ? {} : { command }),
        ...(fix === undefined ? {} : { fix }),
    };
};

// The one verb offered from this strip: everything else the agent can be asked to do is a standing button in its own
// panel (deviceAgent.ts), and belongs there whether or not anything is wrong.
const forgetUnreachable = (): DeviceAgentFix => ({
    kind: `agent`,
    label: `Forget them`,
    hint: `Drops only the links that have answered nothing for long enough to be gone, and restarts its agent against what is left. Every link that is answering — including the one this page is talking over — is left exactly as it is.`,
    op: `forget-unreachable`,
});

// Links this machine keeps dialling into nothing: sandboxes deleted or recreated at another address, which its agent
// will re-dial for as long as the machine runs. Counted from the machine's own live reading, so it clears itself when
// the agent comes back holding fewer links, and it is raised only where the button can travel — a machine with a gap
// cannot hear the drop, and its gap is the sentence above this one.
const linksConcern = (device: Device, readAt: number): DeviceConcern | undefined => {
    const links = device.facts?.links;
    // Same floor the agent's own verbs are drawn at (deviceAgent.ts): a machine holding no socket, or holding one with
    // "Run commands" off, cannot be asked to do this, and a button that only ever refuses is worse than no button.
    if (links === undefined || links.unreachable === 0 || device.online !== true || device.gap !== undefined) {
        return undefined;
    }
    const since = links.unreachableSince;
    const count =
        links.unreachable === 1
            ? `One of its ${links.total} sandbox links has`
            : `${links.unreachable} of its ${links.total} sandbox links have`;
    return {
        key: `links`,
        tone: `info`,
        icon: `link-broken`,
        // `days`, unlike every other age on this page: these outages are measured in weeks, and the default's absolute
        // date mid-sentence answers "when did it break" where the reader is asking "how long have I been dialling it".
        text: `${count} stopped answering${since === undefined ? `` : `, the oldest ${timeAgo(since, { now: readAt, days: true })}`}.`,
        hint: `A sandbox that was deleted, or recreated at a new address, leaves its side of the link on this machine. The agent keeps dialling it — slowly, forever — and nothing will ever answer.`,
        fix: forgetUnreachable(),
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
            text: `Last heard from ${timeAgo(device.report?.capturedAt ?? readAt, { now: readAt })}.`,
            hint: `Everything below is what the machine looked like then, not now.`,
        });
    }
    // After the machine's own state, before the door: this is about what it is holding, which only means anything once
    // the reader knows it is answering at all.
    const links = linksConcern(device, readAt);
    if (links !== undefined) {
        concerns.push(links);
    }
    // Last, and quietest: nothing here is broken, it only explains an absence of buttons.
    if (block !== undefined) {
        concerns.push(blockConcern(block, reconnectable));
    }
    return concerns;
};
