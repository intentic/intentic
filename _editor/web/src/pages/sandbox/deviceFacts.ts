import { agentBuildSkew, agentStalled, type Device, type DeviceAgent, isBehind } from "@intentic/sandbox-contract";
// The deep path rather than the barrel: this module is a pure derivation, and the barrel drags in every
// component in the kit (and with them the DOM). deviceDetail.ts is itself structural by design — see its own
// note about carrying no domain dependency — so the two make the same bargain from opposite sides.
import { groupNeedsAttention, type DeviceSandboxGroup } from "@intentic/ui/device";
import { timeAgo } from "@intentic/ui/format";

/* WHAT A DEVICES ROW SAYS ABOUT THE MACHINE ITSELF, as opposed to what the machine is doing for this sandbox.
 *
 * The tab was built around the second half, folders, ports, containers, the watcher behind them, and shipped
 * with no answer to the first: a Windows laptop and a Linux desktop rendered as the same line of text with a
 * different name on it. That is worst on exactly the rows that already need help, because a machine with no sync
 * agent, or one that is asleep, has NOTHING else to show: it drew a name, a badge and a sentence about what is
 * missing, three times over, and the reader could not tell which device was which.
 *
 * Every fact here comes off the row the daemon already sends (see DeviceSchema), the platform the capability
 * card names, what the machine said about itself when it connected, and the two agent versions. Derivation is
 * here rather than in the template because it is a pile of small judgements about which of them are worth the
 * width, and those are worth reading in one place and pinning in a test. */

// The platform slugs the capability cards use, in the words people say them in. An unknown slug is shown as it
// arrived: a machine whose OS this build has never heard of is still a Linux-or-Windows question to its owner,
// and a strange word on the row beats a row that claims no OS at all.
const PLATFORM_NAMES: Record<string, string> = { windows: `Windows`, linux: `Linux`, macos: `macOS` };

/* THE OS, at the length a row can carry. The machine's own name for itself is the good answer, "Windows 11 Pro",
 * "Ubuntu 24.04.1 LTS", and it arrives with a build or kernel version in parentheses, which is precise and often
 * longer than the name it qualifies. So the parenthetical moves to the row's tooltip (`osTitle`) and the row
 * keeps the part somebody reads. A machine that has never described itself falls back to its platform, which is
 * known from the moment it was added. */
export const osLabel = (device: Device): string | undefined => {
    const described = device.facts?.os.split(` (`)[0]?.trim();
    if (described !== undefined && described !== ``) {
        return described;
    }
    return device.platform === undefined ? undefined : (PLATFORM_NAMES[device.platform] ?? device.platform);
};

// The full string behind that label, when there is more to it than the row shows.
export const osTitle = (device: Device): string | undefined => (device.facts?.os === osLabel(device) ? undefined : device.facts?.os);

/* WHAT THE MACHINE IS, as one wrapping line of parts, the two facts that decide how work on it behaves, then
 * who it thinks it is.
 *
 * The machine's own name for itself appears only when the row is showing something else: the label is the
 * enrolled machine's name or the capability id the user typed, and either can differ from the hostname the
 * machine answers to, which is the name that turns up in its own logs and terminals. "my-pc · hostname my-pc"
 * is the kind of line that makes a reader stop reading the rest. */
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

/* HOW THIS SANDBOX REACHES IT: one tag per open door, and NO VERSION ON ANY OF THEM.
 *
 * The version used to ride here, and that is the bug this pair of functions was split to fix. One chip carried
 * the enrollment's name and the agent's version together — "desktop sync 1.243.0" — and 1.243.0 is neither
 * desktop sync's nor the enrollment's: it is `intentic-machine`, the ONE binary whose single resident process
 * serves the sync watcher and the sandbox socket alike. Three things followed from gluing them together:
 *
 *   • a mirror enrollment rendered the identical number as "ports only 1.243.0", so one binary's version wore
 *     two product names depending on which half the device happened to hold
 *   • the chip only existed where `sync` did, so a device connected purely as a computer showed no version and
 *     no update offer at all, though the same agent was running on it and its version was known
 *   • the running build was a THIRD fact, mentioned only as amber prose deep inside the row
 *
 * So doors are doors (what this sandbox can reach the device through) and the agent is the agent (agentChip
 * below). Both tags are worth having: `desktop sync` over a mirror enrollment is the one word that misleads —
 * a device mirroring ports is paired, reports, has a live loop and a green row, and syncs no files at all —
 * and `commands` was previously not shown anywhere, so a row with every button on it said nothing about why. */
export interface DeviceDoor {
    name: string;
}

export const deviceDoors = (device: Device): DeviceDoor[] => [
    ...(device.sync === undefined ? [] : [{ name: device.sync.mode === `mirror` ? `ports only` : `desktop sync` }]),
    // The door every verb on this row travels through, and the one that was left implicit. A reader looking at
    // a row with no buttons has to be able to see that this is what it does not have.
    ...(device.hostId === undefined ? [] : [{ name: `commands` }]),
];

/* THE AGENT ON THIS DEVICE, AS ONE CHIP: which build is serving, which is installed beside it, and whether a
 * newer one has been published. One chip because it is one binary, and it is beside the device's name because
 * every remedy on this row is about it.
 *
 * WHICH NUMBER IS "the" VERSION: what is RUNNING, because that is what the device's behaviour comes from. The
 * installed build only earns a word when it differs, and then it is not a version to read but an errand — the
 * loop keeps the build it started with, so somebody is owed a restart (agentBuildSkew states the same rule for
 * the terminal). `agentVersion` is the last fallback: the hello frame's number, which is all a row whose
 * "Run commands" switch is off, or which has no agent to answer `status --json`, can offer. Without it the chip
 * went blank on exactly the rows that most need explaining.
 *
 * `latest` is the release this sandbox knows about (/info, the same value behind its own update badge); every
 * first-party build is stamped to it, so it is the right yardstick for an agent as much as for the daemon. When
 * it is unknown, or the agent is a working-tree build, `available` stays absent: see isBehind, where every kind
 * of not-knowing resolves to silence rather than to a nag nobody can act on. */
export interface AgentChip {
    /** The build serving, or the best-known version when nothing is. Absent only when no door said anything. */
    version?: string;
    /** The build on disk, only when the loop is serving a different one: an owed restart, not a second version. */
    installed?: string;
    /** The published release this one is behind. */
    available?: string;
}

/* WHICH NUMBER THE CHIP SHOWS, in falling order of what it actually tells the reader: the build serving, the
 * build on disk when nothing is serving, and the hello frame's when there is no report to read at all. */
const agentVersionOf = (agent: DeviceAgent | undefined, announced: string | undefined): string | undefined =>
    agent?.build ?? agent?.installed ?? announced;

export const agentChip = (device: Device, latest?: string): AgentChip | undefined => {
    const agent = device.report?.agent;
    const version = agentVersionOf(agent, device.agentVersion);
    if (version === undefined) {
        return undefined;
    }
    /* Staleness is asked of the INSTALLED build where there is one, because that is what an update replaces: a
     * device whose file is already current and whose loop is behind is owed a restart, not a download, and
     * offering "1.244.0 available" there would send the reader after bytes they already have. */
    /* THE INSTALLED BUILD IS ONLY WORTH A WORD AGAINST A KNOWN RUNNING ONE. agentBuildSkew answers for an
     * UNSTAMPED loop too, deliberately — a loop too old to stamp its own build is behind by definition, and
     * that is the loudest case for the terminal, which has a whole sentence to spend on it. Here it would put
     * the same number on the chip twice ("agent 0.1.0 · 0.1.0 installed"), because `version` has already
     * fallen back to the file. So the chip states the pair only when they are two different numbers; the
     * unstamped case still reaches the reader as the Agent block's own restart button (staleBuild). */
    const skew = agent === undefined ? undefined : agentBuildSkew(agent);
    const differs = skew !== undefined && skew.running !== undefined;
    const behind = agent?.installed ?? version;
    return {
        version,
        ...(differs ? { installed: skew.installed } : {}),
        ...(isBehind(behind, latest) && latest !== undefined ? { available: latest } : {}),
    };
};

/* HOW LONG SINCE AN ENROLLED MACHINE USED ITS ENROLLMENT before its sync counts as STOPPED. The daemon refreshes
 * seenAt at most once a minute while the agent polls (every 5s), so a live machine is always well inside this;
 * anything older means the agent stopped polling, the machine is asleep or offline, or its pairing was taken
 * over by another sandbox's setup on the same device.
 *
 * Enrollment ALONE used to be the signal, which is how the old card claimed "Syncing from X" for as long as the
 * record existed, whether or not anything was syncing: the exact failure that let a lost pairing go unnoticed
 * for days. It moved here with the fact it judges. */
const SYNC_STALE_MS = 5 * 60 * 1000;

/* WHETHER THIS DEVICE'S ENROLLMENT HAS GONE QUIET. An enrollment that has NEVER been used counts as stopped
 * too: that is a setup somebody started and did not finish, and it is indistinguishable from a working one on
 * every other signal the row has. */
export const syncStopped = (device: Device, now: number): boolean =>
    device.sync !== undefined && (device.sync.seenAt === undefined || now - device.sync.seenAt > SYNC_STALE_MS);

/* WHAT THE ENROLLMENT SAYS, as the one line a folded row can carry, and it is deliberately about the MACHINE
 * rather than about any sandbox under it: which half of desktop sync this device holds, and whether it is
 * still doing it. The per-sandbox half (which folder, which ports, is Mutagen happy) is the report's, drawn by
 * <DeviceDetail> in the rows below.
 *
 * Silent on a machine with no enrollment: a connected device that has never been paired for sync is not
 * missing anything, and a "no desktop sync" on every one of them is a word that stops being read. */
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

/* Whether this device's agent is one the user should replace: asked of the build ON DISK, because that is what
 * an update downloads over. A device already holding the current file and serving an older loop is a different
 * errand with a different button (agentBuildSkew → Restart), so it must not be offered a download. */
export const agentBehind = (device: Device, latest?: string): boolean => isBehind(device.report?.agent.installed, latest);

/* WHAT A FOLDED DEVICE'S LINE SAYS, and the whole reason folding one is safe: a machine collapsed to a chevron
 * only beats the wall it replaced if the closed line still answers "is anything wrong under here".
 *
 * Two kinds, kept apart because they are read differently and it is the same split <DeviceDetail> makes one
 * tier down (groupSummary): FACTS are counted at a glance and never coloured, WARNINGS keep their ink and are
 * the reason to open the row.
 *
 * Here rather than in the component because it is now eight judgements rather than three, and because "does a
 * quiet enrollment warn" is exactly the kind of rule that should be pinned in a test rather than re-read out of
 * a template. */
export interface DeviceSummary {
    readonly facts: readonly string[];
    readonly warnings: readonly string[];
}

// Whether this device's agent is up but no longer making rounds: the same rule the terminal uses, so a row
// and `intentic-machine status` cannot disagree about one device.
const agentHalted = (device: Device, now: number): boolean => device.report !== undefined && agentStalled(device.report.agent, now);

// Split in two, like groupSummary's own halves one tier down, because the two are read differently and neither
// reads the other: what is counted, and what is coloured.
const summaryFacts = (device: Device, groups: readonly DeviceSandboxGroup[], now: number): string[] => {
    const facts: string[] = [];
    const running = groups.filter((group) => group.sandbox?.running === true).length;
    if (groups.length > 0) {
        facts.push(groups.length === 1 ? `1 sandbox` : `${groups.length} sandboxes`);
    }
    if (running > 0) {
        facts.push(`${running} running`);
    }
    /* WHAT THIS DEVICE IS DOING FOR THE SANDBOX, which is the question the tab is opened with and which used
     * to be answered by a card underneath the list, for one machine, in the singular. Only while it is actually
     * doing it; a quiet enrollment is a warning below rather than a fact here. */
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
    /* AN ENROLLMENT NOBODY HAS USED, which is the failure every surface in this product used to keep reading as
     * healthy: the record exists, so the row is green, and nothing is reaching that machine's folder. */
    const note = syncNote(device, now);
    if (note !== undefined && syncStopped(device, now)) {
        warnings.push(note);
    }
    /* The agent is a fact about the DEVICE rather than any row under it, so it belongs on the device's own
     * line, and it is the failure this whole area exists to surface: a dead loop leaves every row beneath it
     * reading exactly as it did the moment before. */
    if (device.report !== undefined && (!device.report.agent.running || agentHalted(device, now))) {
        warnings.push(`agent stopped`);
    }
    return warnings;
};

export const deviceSummary = (device: Device, groups: readonly DeviceSandboxGroup[], now: number): DeviceSummary => ({
    facts: summaryFacts(device, groups, now),
    warnings: summaryWarnings(device, groups, now),
});

/* WHEN IT WAS LAST HERE, and only when it is not here now. On a live row it is noise the badge already carries;
 * on an offline one it is the single most useful thing left to say, because "asleep since this morning" and
 * "gone since April" are different situations wearing the same grey badge. */
export const lastSeenNote = (device: Device): string | undefined =>
    device.online === false && device.lastSeen !== undefined ? `last seen ${timeAgo(device.lastSeen)}` : undefined;

/* WHY THIS DEVICE'S SANDBOXES HAVE NO BUTTONS, and the one thing that would give them some.
 *
 * The tab drew half a row and said nothing about the other half. A machine paired by the desktop app is enrolled
 * for desktop sync ALONE, and a sync agent never reports a machine's containers, deliberately, because
 * volunteering the list of a box's other sandboxes to one of them is the disclosure that design avoids by
 * construction (see the sync agent's report). So the row arrived with folders and ports, an empty container list,
 * and therefore no image, no running dot and none of the verbs the desktop app's own manager window has had all
 * along. Nothing on screen connected those two facts, which is exactly how "we were supposed to have parity"
 * turns into "I cannot find it in the browser".
 *
 * The remedy is real and already built: add the machine as a CONNECTED DEVICE and the daemon may ask it
 * directly, same containers, same verbs, over the machine's own socket with no agent or model in the loop. That
 * is a switch and a one-liner, so it is worth a sentence and a button rather than a silence.
 *
 * Two things can be in the way, and they are different errands:
 *
 *   • there is no device connection at all, the common case, and the only one that needs a NEW card
 *   • there is one, and the owner has not granted it the sandbox switches, which are off by default
 *
 * Everything else that stops a row (asleep, no sync agent, "Run commands" blocked) is already a `gap` the row
 * states in its own line, so this stays quiet about those rather than saying the same thing twice. */

// The cards that connect a device, keyed by the platform slug the row already carries, they ARE their card's
// id (the `devices` extension contributes `windows` and `linux`). A machine whose platform has no card still
// gets the sentence; it just gets no button beside it, because there is nothing honest to point at.
const HOST_CARD: Record<string, string> = { windows: `windows`, linux: `linux` };

export const hostCard = (platform: string | undefined): string | undefined => (platform === undefined ? undefined : HOST_CARD[platform]);

/* What stands between this row and its buttons. `card` is where the fix is, and it is OPTIONAL throughout: a Mac
 * has no card to connect it with, and a connection whose stored platform this build does not recognise still has
 * a switch to describe even when the link to it cannot be built. */
export type ManageBlock =
    // No device connection at all, the row can never show a container until one exists.
    | { readonly kind: `connect`; readonly card?: string | undefined }
    /* Connected as a device, and that device is not holding a socket right now: asleep, off the network, or
     * its agent is not running. The row this reaches is the one that gave this whole area away — a machine
     * syncing files perfectly, its folders and ports and sandboxes all listed, its badge green, and not one
     * button anywhere, because every verb needs the device door and that door is shut. It said nothing at all
     * about it: `online` is a fact this page reads and never printed, so the reader was left to conclude the
     * buttons had not been built. */
    | { readonly kind: `offline`; readonly connection: string; readonly card?: string | undefined }
    // Connected, but "Manage sandboxes on this device" is off, so every verb here would be refused.
    | { readonly kind: `sandboxes-off`; readonly connection: string; readonly card?: string | undefined }
    // Everything works except the one that cannot be undone, which has a switch of its own.
    | { readonly kind: `remove-off`; readonly connection: string; readonly card?: string | undefined };

/* The switches, as the capability stores them. A host card's config is a flat record of the owner's answers, and
 * the two that matter here default to "off", so a freshly connected device lists its containers (listing rides
 * "Run commands") and refuses every button on them, which is the state this exists to stop being a surprise. */
export type DeviceScopes = Readonly<Record<string, string | number | boolean>>;

// The card an EXISTING connection came from: host cards pin their own id into `platform`, which is what lets one
// card's connections be told from another's. Falls back to the row's platform, which is the same fact read off
// the machine rather than off the card.
const cardOf = (device: Device, scopes: DeviceScopes | undefined): string | undefined => {
    const pinned = scopes?.[`platform`];
    return typeof pinned === `string` && pinned !== `` ? pinned : hostCard(device.platform);
};

export const manageBlock = (device: Device, scopes: DeviceScopes | undefined): ManageBlock | undefined => {
    if (device.hostId === undefined) {
        /* Only where there is a list to explain. A machine that has not reported at all draws no sandbox block,
         * the row already says it is enrolled and silent, and telling that reader what desktop sync does not
         * carry is the second sentence of a paragraph whose first one is "we have not heard from this device". */
        if (device.report === undefined) {
            return undefined;
        }
        const card = hostCard(device.platform);
        return { kind: `connect`, ...(card === undefined ? {} : { card }) };
    }
    const card = cardOf(device, scopes);
    const link = { connection: device.hostId, ...(card === undefined ? {} : { card }) };
    /* THE DOOR IS THERE AND SHUT, which is the state this block had no words for, and the one a reader is most
     * likely to be standing in: a machine reaches this page through two independent doors, and the sync one
     * being wide open says nothing at all about the other. Only where the row is not ALREADY saying it — a row
     * with no report of its own renders `gap: offline` ("Asleep or offline.") a few pixels above, and the same
     * sentence twice reads as a page that lost its place. */
    if (device.online !== true) {
        return device.gap === undefined ? { kind: `offline`, ...link } : undefined;
    }
    /* A machine that would not answer already says so in its own line. Repeating "and also your switches" under
     * it would be advice about a device nobody can reach, and the switches may well be on, since a gap is the
     * reason nothing could be read to find out. */
    if (device.gap !== undefined) {
        return undefined;
    }
    if (scopes?.[`sandboxes`] !== `on`) {
        return { kind: `sandboxes-off`, ...link };
    }
    return scopes[`sandboxRemove`] === `on` ? undefined : { kind: `remove-off`, ...link };
};
