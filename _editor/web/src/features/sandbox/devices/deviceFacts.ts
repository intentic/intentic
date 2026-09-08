import { agentBuildSkew, agentStalled, type Device, type DeviceAgent, isBehind } from "@intentic/sandbox-contract";
import { groupNeedsAttention, type DeviceSandboxGroup } from "@intentic/ui/device";
import { timeAgo } from "@intentic/ui/format";

// What a Devices row says about the machine itself, as distinct from what it's doing for this sandbox
// (folders, ports, containers). Every fact comes from the daemon's own row (DeviceSchema), the capability
// card's platform, what the machine announced on connect, and the two agent versions.

// Platform slugs from the capability cards; an unknown slug is shown verbatim rather than as nothing.
const PLATFORM_NAMES: Record<string, string> = { windows: `Windows`, linux: `Linux`, macos: `macOS` };

// The OS label at row length: the machine's own name with any build/kernel parenthetical stripped (kept in
// osTitle); falls back to platform when it has never described itself.
export const osLabel = (device: Device): string | undefined => {
    const described = device.facts?.os.split(` (`)[0]?.trim();
    if (described !== undefined && described !== ``) {
        return described;
    }
    return device.platform === undefined ? undefined : (PLATFORM_NAMES[device.platform] ?? device.platform);
};

// The full string, when there is more to it than the label shows.
export const osTitle = (device: Device): string | undefined => (device.facts?.os === osLabel(device) ? undefined : device.facts?.os);

// What the machine is, as wrapping parts: arch, shell, then hostname — shown only when it differs from the
// row's own label.
export const deviceHardware = (device: Device): string[] => {
    const parts: string[] = [];
    if (device.facts !== undefined) {
        parts.push(device.facts.arch, device.facts.shell);
    }
    const hostname = device.report?.hostname;
    if (hostname !== undefined && hostname.toLowerCase() !== device.label.toLowerCase()) {
        parts.push(hostname);
    }
    return parts;
};

// How this sandbox reaches the device, one tag per open door, with no agent version on either: the version
// belongs to agentChip below, since both doors can share one running binary.
export interface DeviceDoor {
    name: string;
}

export const deviceDoors = (device: Device): DeviceDoor[] => [
    ...(device.sync === undefined ? [] : [{ name: device.sync.mode === `mirror` ? `ports only` : `desktop sync` }]),
    // The door every verb on the row travels through; a row with no buttons should show it's missing.
    ...(device.hostId === undefined ? [] : [{ name: `commands` }]),
];

// The agent as one chip: the build serving (what the device's behaviour comes from), the installed build only
// when it differs (an owed restart), falling back to the hello frame's version when there's no report.
export interface AgentChip {
    /** The build serving, or the best-known version; absent only when no door said anything. */
    version?: string;
    /** The build on disk, only when the loop serves a different one (an owed restart). */
    installed?: string;
    /** The published release this one is behind. */
    available?: string;
}

// Falling order of what actually tells the reader something: build serving, then on disk, then the hello
// frame's announced version.
const agentVersionOf = (agent: DeviceAgent | undefined, announced: string | undefined): string | undefined =>
    agent?.build ?? agent?.installed ?? announced;

export const agentChip = (device: Device, latest?: string): AgentChip | undefined => {
    const agent = device.report?.agent;
    const version = agentVersionOf(agent, device.agentVersion);
    if (version === undefined) {
        return undefined;
    }
    // Judged against the installed build, since that's what an update replaces; current-on-disk but behind on the
    // loop needs a restart, not a download.
    // Stated only when running and installed differ, so it isn't printed twice; an unstamped loop is handled by
    // the Agent block's own restart button instead.
    const skew = agent === undefined ? undefined : agentBuildSkew(agent);
    const differs = skew !== undefined && skew.running !== undefined;
    const behind = agent?.installed ?? version;
    return {
        version,
        ...(differs ? { installed: skew.installed } : {}),
        ...(isBehind(behind, latest) && latest !== undefined ? { available: latest } : {}),
    };
};

// Window before an enrolled device's sync counts as stopped. The daemon refreshes seenAt at most once a minute
// while the agent polls every 5s, so a live machine stays well inside it.
const SYNC_STALE_MS = 5 * 60 * 1000;

// An enrollment that has never checked in also counts as stopped: indistinguishable from a working one on
// every other signal the row has.
export const syncStopped = (device: Device, now: number): boolean =>
    device.sync !== undefined && (device.sync.seenAt === undefined || now - device.sync.seenAt > SYNC_STALE_MS);

// The one line a folded row carries about its enrollment: which half it holds, and whether it's still active.
// Silent when there is no enrollment.
export const syncNote = (device: Device, now: number): string | undefined => {
    if (device.sync === undefined) {
        return undefined;
    }
    const what = device.sync.mode === `mirror` ? `mirroring ports` : `syncing files and ports`;
    if (!syncStopped(device, now)) {
        return what;
    }
    return device.sync.seenAt === undefined ? `enrolled for ${what}, never checked in` : `${what}: stopped`;
};

// Judged on the installed build, since that's what an update downloads over; a stale-loop-only device needs
// agentBuildSkew's restart instead.
export const agentBehind = (device: Device, latest?: string): boolean => isBehind(device.report?.agent.installed, latest);

// A folded device's line: facts are counted and never coloured; warnings keep their ink and are the reason to
// open the row.
export interface DeviceSummary {
    readonly facts: readonly string[];
    readonly warnings: readonly string[];
}

// Same rule the terminal uses (agentStalled), so a row and `intentic-machine status` cannot disagree.
const agentHalted = (device: Device, now: number): boolean => device.report !== undefined && agentStalled(device.report.agent, now);

// Split from warnings the same way groupSummary splits its own: counted vs coloured.
const summaryFacts = (device: Device, groups: readonly DeviceSandboxGroup[], now: number): string[] => {
    const facts: string[] = [];
    const running = groups.filter((group) => group.sandbox?.running === true).length;
    if (groups.length > 0) {
        facts.push(groups.length === 1 ? `1 sandbox` : `${groups.length} sandboxes`);
    }
    if (running > 0) {
        facts.push(`${running} running`);
    }
    // Only while actually syncing; a quiet enrollment is a warning below, not a fact here.
    const note = syncNote(device, now);
    if (note !== undefined && !syncStopped(device, now)) {
        facts.push(note);
    }
    return facts;
};

const summaryWarnings = (device: Device, groups: readonly DeviceSandboxGroup[], now: number): string[] => {
    const warnings: string[] = [];
    const attention = groups.filter(groupNeedsAttention).length;
    if (attention > 0) {
        warnings.push(attention === 1 ? `1 needs attention` : `${attention} need attention`);
    }
    // An unused enrollment reads as healthy everywhere else, so it has to warn here.
    const note = syncNote(device, now);
    if (note !== undefined && syncStopped(device, now)) {
        warnings.push(note);
    }
    // A dead loop leaves every row beneath it reading as it did the moment before; said once, here.
    if (device.report !== undefined && (!device.report.agent.running || agentHalted(device, now))) {
        warnings.push(`agent stopped`);
    }
    return warnings;
};

export const deviceSummary = (device: Device, groups: readonly DeviceSandboxGroup[], now: number): DeviceSummary => ({
    facts: summaryFacts(device, groups, now),
    warnings: summaryWarnings(device, groups, now),
});

// Only shown when offline: noise on a live row, the most useful fact on one that isn't.
export const lastSeenNote = (device: Device): string | undefined =>
    device.online === false && device.lastSeen !== undefined ? `last seen ${timeAgo(device.lastSeen)}` : undefined;

// Why a device's sandboxes have no buttons: desktop sync alone never reports containers, and even a connected
// device needs the sandbox switches granted. Two distinct gaps: no device connection, or one without the grant.

// Cards that connect a device, keyed by platform slug; a platform with no card still gets the sentence, no button.
const HOST_CARD: Record<string, string> = { windows: `windows`, linux: `linux` };

export const hostCard = (platform: string | undefined): string | undefined => (platform === undefined ? undefined : HOST_CARD[platform]);

// What stands between a row and its buttons. `card` is optional throughout: a Mac has no card, and an
// unrecognised platform still has a switch to describe with no link to build.
export type ManageBlock =
    // No device connection at all; the row can never show a container until one exists.
    | { readonly kind: `connect`; readonly card?: string | undefined }
    // Connected as a device but not holding a socket right now (asleep, no network, agent down): the row where
    // files sync perfectly yet no verb works, since every verb needs this door.
    | { readonly kind: `offline`; readonly connection: string; readonly card?: string | undefined }
    // Connected, but "Manage sandboxes on this device" is off, so every verb here would be refused.
    | { readonly kind: `sandboxes-off`; readonly connection: string; readonly card?: string | undefined }
    // Everything works except the one that can't be undone, gated by its own switch.
    | { readonly kind: `remove-off`; readonly connection: string; readonly card?: string | undefined };

// Capability config as the owner set it; both switches default off, so a freshly connected device lists
// containers but refuses every button.
export type DeviceScopes = Readonly<Record<string, string | number | boolean>>;

// The card an existing connection came from (host cards pin their id into `platform`), falling back to the
// row's own platform.
const cardOf = (device: Device, scopes: DeviceScopes | undefined): string | undefined => {
    const pinned = scopes?.[`platform`];
    return typeof pinned === `string` && pinned !== `` ? pinned : hostCard(device.platform);
};

export const manageBlock = (device: Device, scopes: DeviceScopes | undefined): ManageBlock | undefined => {
    if (device.hostId === undefined) {
        // Only where there's a list to explain; an unreported device's row already says it's enrolled and silent.
        if (device.report === undefined) {
            return undefined;
        }
        const card = hostCard(device.platform);
        return { kind: `connect`, ...(card === undefined ? {} : { card }) };
    }
    const card = cardOf(device, scopes);
    const link = { connection: device.hostId, ...(card === undefined ? {} : { card }) };
    // The device door can be shut while the sync door stays open. Suppressed when the row's own `gap` already
    // explains the silence.
    if (device.online !== true) {
        return device.gap === undefined ? { kind: `offline`, ...link } : undefined;
    }
    // A device that wouldn't answer already says so; its switches may well be on regardless.
    if (device.gap !== undefined) {
        return undefined;
    }
    if (scopes?.[`sandboxes`] !== `on`) {
        return { kind: `sandboxes-off`, ...link };
    }
    return scopes[`sandboxRemove`] === `on` ? undefined : { kind: `remove-off`, ...link };
};
