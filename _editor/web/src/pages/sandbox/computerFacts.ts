import { type Computer, isBehind } from "@intentic/sandbox-contract";
import { timeAgo } from "@intentic/ui/format";

/* WHAT A COMPUTERS ROW SAYS ABOUT THE MACHINE ITSELF, as opposed to what the machine is doing for this sandbox.
 *
 * The tab was built around the second half, folders, ports, containers, the watcher behind them, and shipped
 * with no answer to the first: a Windows laptop and a Linux desktop rendered as the same line of text with a
 * different name on it. That is worst on exactly the rows that already need help, because a machine with no sync
 * agent, or one that is asleep, has NOTHING else to show: it drew a name, a badge and a sentence about what is
 * missing, three times over, and the reader could not tell which computer was which.
 *
 * Every fact here comes off the row the daemon already sends (see ComputerSchema), the platform the capability
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
export const osLabel = (computer: Computer): string | undefined => {
    const described = computer.facts?.os.split(` (`)[0]?.trim();
    if (described !== undefined && described !== ``) {
        return described;
    }
    return computer.platform === undefined ? undefined : (PLATFORM_NAMES[computer.platform] ?? computer.platform);
};

// The full string behind that label, when there is more to it than the row shows.
export const osTitle = (computer: Computer): string | undefined => (computer.facts?.os === osLabel(computer) ? undefined : computer.facts?.os);

/* WHAT THE MACHINE IS, as one wrapping line of parts, the two facts that decide how work on it behaves, then
 * who it thinks it is.
 *
 * The machine's own name for itself appears only when the row is showing something else: the label is the
 * enrolled machine's name or the capability id the user typed, and either can differ from the hostname the
 * machine answers to, which is the name that turns up in its own logs and terminals. "my-pc · hostname my-pc"
 * is the kind of line that makes a reader stop reading the rest. */
export const machineFacts = (computer: Computer): string[] => {
    const parts: string[] = [];
    if (computer.facts !== undefined) {
        parts.push(computer.facts.arch, computer.facts.shell);
    }
    const hostname = computer.report?.hostname;
    if (hostname !== undefined && hostname.toLowerCase() !== computer.label.toLowerCase()) {
        parts.push(hostname);
    }
    return parts;
};

/* HOW THIS SANDBOX REACHES IT, two independent doors, and a box may be behind both.
 *
 * Split out of the fact line rather than sitting at the head of it, because it answers a different question. A
 * row used to run "desktop sync · connected computer · x64 · /usr/bin/zsh · sync agent 0.1.0 · computer agent
 * 0.1.0", six facts of three kinds, one grey, one size, one separator, and the reader had to know which was
 * which to get anything out of it. These are the ones with a shape: each door is one chip, and each carries its
 * own agent's version, so a machine running an old build is visible rather than mysteriously lacking a field.
 *
 * A version is labelled by ITS DOOR rather than by its binary: "desktop sync" and "connected computer" are the
 * names this tab already uses for the two ways in, so nothing needs explaining. */
/* And whether a newer release has passed the agent behind that door, the version and its staleness as one chip,
 * because they are one thought. "desktop sync 0.1.0" was already on the row and was already the answer to a
 * question nobody knew to ask: a machine ran a five-day-old agent through a bug that agent had a fix for, and
 * this chip said so the whole time, to a reader who had no way to know 0.1.0 was not current. A version is only a
 * fact about staleness next to the version it should be.
 *
 * `latest` is the release this sandbox knows about (/info, the same value behind its own update badge), every
 * first-party build is stamped to it, so it is the right yardstick for an agent as much as for the daemon. When
 * it is unknown, or the agent is a working-tree build, the chip renders exactly as it did before: see isBehind,
 * where every kind of not-knowing resolves to silence rather than to a nag somebody cannot act on. */
export interface ComputerDoor {
    name: string;
    version?: string;
    available?: string;
}

const door = (name: string, version: string | undefined, latest: string | undefined): ComputerDoor => ({
    name,
    ...(version === undefined ? {} : { version }),
    ...(isBehind(version, latest) && latest !== undefined ? { available: latest } : {}),
});

export const computerDoors = (computer: Computer, latest?: string): ComputerDoor[] => {
    const doors: ComputerDoor[] = [];
    if (computer.syncEnrolled) {
        doors.push(door(`desktop sync`, computer.report?.agents.sync, latest));
    }
    if (computer.hostId !== undefined) {
        doors.push(door(`connected computer`, computer.hostAgent ?? computer.report?.agents.host, latest));
    }
    return doors;
};

/* Whether this computer's SYNC agent is one the user should replace, the one door that earns a remedy on the
 * row, because it is the one with a command behind it (`intentic-machine upgrade`). The computer agent's version is
 * reported the same way and shown the same way, but nothing here should print an instruction for updating it that
 * has not been built: a wrong command is worse than a fact with no command attached. */
export const syncAgentBehind = (computer: Computer, latest?: string): boolean => isBehind(computer.report?.agents.sync, latest);

/* WHEN IT WAS LAST HERE, and only when it is not here now. On a live row it is noise the badge already carries;
 * on an offline one it is the single most useful thing left to say, because "asleep since this morning" and
 * "gone since April" are different situations wearing the same grey badge. */
export const lastSeenNote = (computer: Computer): string | undefined =>
    computer.online === false && computer.lastSeen !== undefined ? `last seen ${timeAgo(computer.lastSeen)}` : undefined;

/* WHY THIS COMPUTER'S SANDBOXES HAVE NO BUTTONS, and the one thing that would give them some.
 *
 * The tab drew half a row and said nothing about the other half. A machine paired by the desktop app is enrolled
 * for desktop sync ALONE, and a sync agent never reports a machine's containers, deliberately, because
 * volunteering the list of a box's other sandboxes to one of them is the disclosure that design avoids by
 * construction (see the sync agent's report). So the row arrived with folders and ports, an empty container list,
 * and therefore no image, no running dot and none of the verbs the desktop app's own manager window has had all
 * along. Nothing on screen connected those two facts, which is exactly how "we were supposed to have parity"
 * turns into "I cannot find it in the browser".
 *
 * The remedy is real and already built: add the machine as a CONNECTED COMPUTER and the daemon may ask it
 * directly, same containers, same verbs, over the machine's own socket with no agent or model in the loop. That
 * is a switch and a one-liner, so it is worth a sentence and a button rather than a silence.
 *
 * Two things can be in the way, and they are different errands:
 *
 *   • there is no computer connection at all, the common case, and the only one that needs a NEW card
 *   • there is one, and the owner has not granted it the sandbox switches, which are off by default
 *
 * Everything else that stops a row (asleep, no sync agent, "Run commands" blocked) is already a `gap` the row
 * states in its own line, so this stays quiet about those rather than saying the same thing twice. */

// The cards that connect a computer, keyed by the platform slug the row already carries, they ARE their card's
// id (the `computers` extension contributes `windows` and `linux`). A machine whose platform has no card still
// gets the sentence; it just gets no button beside it, because there is nothing honest to point at.
const HOST_CARD: Record<string, string> = { windows: `windows`, linux: `linux` };

export const hostCard = (platform: string | undefined): string | undefined => (platform === undefined ? undefined : HOST_CARD[platform]);

/* What stands between this row and its buttons. `card` is where the fix is, and it is OPTIONAL throughout: a Mac
 * has no card to connect it with, and a connection whose stored platform this build does not recognise still has
 * a switch to describe even when the link to it cannot be built. */
export type ManageBlock =
    // No computer connection at all, the row can never show a container until one exists.
    | { readonly kind: `connect`; readonly card?: string | undefined }
    // Connected, but "Manage sandboxes on this computer" is off, so every verb here would be refused.
    | { readonly kind: `sandboxes-off`; readonly connection: string; readonly card?: string | undefined }
    // Everything works except the one that cannot be undone, which has a switch of its own.
    | { readonly kind: `remove-off`; readonly connection: string; readonly card?: string | undefined };

/* The switches, as the capability stores them. A host card's config is a flat record of the owner's answers, and
 * the two that matter here default to "off", so a freshly connected computer lists its containers (listing rides
 * "Run commands") and refuses every button on them, which is the state this exists to stop being a surprise. */
export type ComputerScopes = Readonly<Record<string, string | number | boolean>>;

// The card an EXISTING connection came from: host cards pin their own id into `platform`, which is what lets one
// card's connections be told from another's. Falls back to the row's platform, which is the same fact read off
// the machine rather than off the card.
const cardOf = (computer: Computer, scopes: ComputerScopes | undefined): string | undefined => {
    const pinned = scopes?.[`platform`];
    return typeof pinned === `string` && pinned !== `` ? pinned : hostCard(computer.platform);
};

export const manageBlock = (computer: Computer, scopes: ComputerScopes | undefined): ManageBlock | undefined => {
    if (computer.hostId === undefined) {
        /* Only where there is a list to explain. A machine that has not reported at all draws no sandbox block,
         * the row already says it is enrolled and silent, and telling that reader what desktop sync does not
         * carry is the second sentence of a paragraph whose first one is "we have not heard from this computer". */
        if (computer.report === undefined) {
            return undefined;
        }
        const card = hostCard(computer.platform);
        return { kind: `connect`, ...(card === undefined ? {} : { card }) };
    }
    /* A machine that is asleep, or that would not answer, already says so in its own line. Repeating "and also
     * your switches" under it would be advice about a computer nobody can reach, and the switches may well be
     * on, since a gap is the reason nothing could be read to find out. */
    if (computer.online !== true || computer.gap !== undefined) {
        return undefined;
    }
    const card = cardOf(computer, scopes);
    const link = { connection: computer.hostId, ...(card === undefined ? {} : { card }) };
    if (scopes?.[`sandboxes`] !== `on`) {
        return { kind: `sandboxes-off`, ...link };
    }
    return scopes[`sandboxRemove`] === `on` ? undefined : { kind: `remove-off`, ...link };
};
