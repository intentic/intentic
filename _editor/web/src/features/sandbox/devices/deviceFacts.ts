import { agentBuildSkew, agentStalled, type Device, type DeviceAgent, isBehind, reportQuiet } from "@intentic/sandbox-contract";
import { timeAgo } from "@intentic/ui/format";

// What a Devices row says about the machine itself, as distinct from what it's doing for this sandbox
// (folders, ports, containers). Every fact comes from the daemon's own row (DeviceSchema), the capability
// card's platform, what the machine announced on connect, and the two agent versions.

// `readAt` throughout is when this reading reached the browser, not the wall clock: every judgement here is about what
// the machine was doing when we last heard from it, so a list nobody has re-read cannot age into a verdict of its own.

// Platform slugs from the capability cards; an unknown slug is shown verbatim rather than as nothing.
const PLATFORM_NAMES: Record<string, string> = { windows: `Windows`, linux: `Linux`, macos: `macOS` };

// The machine's own name for its OS, with any build/kernel parenthetical stripped (that goes to osTitle). Absent
// until it has connected as a device and described itself.
const describedOs = (device: Device): string | undefined => {
    const described = device.facts?.os.split(` (`)[0]?.trim();
    return described === undefined || described === `` ? undefined : described;
};

// What the platform slug is worth saying on its own: the last resort, since every machine of an OS answers it
// identically.
const platformName = (device: Device): string | undefined =>
    device.platform === undefined ? undefined : (PLATFORM_NAMES[device.platform] ?? device.platform);

// The OS label at row length. A WSL distro says so here, in the loudest ink the row has, rather than down in the
// hardware line: WSL hands the distro the Windows machine's hostname, so two rows can arrive named the same, and
// which environment each one is is the whole difference between them. The distro's name outranks the bare platform
// for the same reason — "Linux" is what its neighbour distro would say too.
export const osLabel = (device: Device): string | undefined => {
    const wsl = device.report?.wsl;
    if (wsl === undefined) {
        return describedOs(device) ?? platformName(device);
    }
    const named = describedOs(device) ?? (wsl.distro === `` ? undefined : wsl.distro) ?? platformName(device);
    return named === undefined ? `WSL` : `${named} on WSL`;
};

// The full string, when there is more to it than the label shows. Compared against the OS alone, so the WSL suffix
// never makes a machine look like it has more to say than it does.
export const osTitle = (device: Device): string | undefined => (device.facts?.os === describedOs(device) ? undefined : device.facts?.os);

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
export const syncStopped = (device: Device, readAt: number): boolean =>
    device.sync !== undefined && (device.sync.seenAt === undefined || readAt - device.sync.seenAt > SYNC_STALE_MS);

// The one line a folded row carries about its enrollment: which half it holds, and whether it's still active.
// Silent when there is no enrollment.
export const syncNote = (device: Device, readAt: number): string | undefined => {
    if (device.sync === undefined) {
        return undefined;
    }
    const what = device.sync.mode === `mirror` ? `mirroring ports` : `syncing files and ports`;
    if (!syncStopped(device, readAt)) {
        return what;
    }
    return device.sync.seenAt === undefined ? `enrolled for ${what}, never checked in` : `${what}: stopped`;
};

// Judged on the installed build, since that's what an update downloads over; a stale-loop-only device needs
// agentBuildSkew's restart instead.
export const agentBehind = (device: Device, latest?: string): boolean => isBehind(device.report?.agent.installed, latest);

// Whether the machine had gone quiet by the time this reading reached us (REPORT_QUIET_AFTER_MS). Aged against the
// reading, never the clock, so a cached list painted on open says what it said, instead of inventing a silence.
export const deviceQuiet = (device: Device, readAt: number): boolean =>
    device.report !== undefined && reportQuiet(device.report, readAt);

// Same rule the terminal uses (agentStalled), so a row and `intentic-machine status` cannot disagree. Judged on the
// machine's own clock, which stamps both the tick and the capture: an old reading of a healthy loop is old, not dead.
export const agentHalted = (device: Device): boolean =>
    device.report !== undefined && agentStalled(device.report.agent, device.report.capturedAt);

// What is wrong with the machine itself, as distinct from what is wrong with one of its sandboxes: a board
// card states these under the sandbox lines, which carry their own.
export const machineWarnings = (device: Device, readAt: number): readonly string[] => {
    const warnings: string[] = [];
    // An unused enrollment reads as healthy everywhere else, so it has to warn here.
    const note = syncNote(device, readAt);
    if (note !== undefined && syncStopped(device, readAt)) {
        warnings.push(note);
    }
    // A dead loop leaves every fact beneath it reading as it did the moment before; said once, here.
    if (device.report !== undefined && (!device.report.agent.running || agentHalted(device))) {
        warnings.push(`agent stopped`);
    }
    return warnings;
};

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
