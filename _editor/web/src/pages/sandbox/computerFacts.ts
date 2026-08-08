import type { Computer } from "@intentic/sandbox-contract";
import { timeAgo } from "@intentic/ui/format";

/* WHAT A COMPUTERS ROW SAYS ABOUT THE MACHINE ITSELF, as opposed to what the machine is doing for this sandbox.
 *
 * The tab was built around the second half — folders, ports, containers, the watcher behind them — and shipped
 * with no answer to the first: a Windows laptop and a Linux desktop rendered as the same line of text with a
 * different name on it. That is worst on exactly the rows that already need help, because a machine with no sync
 * agent, or one that is asleep, has NOTHING else to show: it drew a name, a badge and a sentence about what is
 * missing, three times over, and the reader could not tell which computer was which.
 *
 * Every fact here comes off the row the daemon already sends (see ComputerSchema) — the platform the capability
 * card names, what the machine said about itself when it connected, and the two agent versions. Derivation is
 * here rather than in the template because it is a pile of small judgements about which of them are worth the
 * width, and those are worth reading in one place and pinning in a test. */

// The platform slugs the capability cards use, in the words people say them in. An unknown slug is shown as it
// arrived: a machine whose OS this build has never heard of is still a Linux-or-Windows question to its owner,
// and a strange word on the row beats a row that claims no OS at all.
const PLATFORM_NAMES: Record<string, string> = { windows: `Windows`, linux: `Linux`, macos: `macOS` };

/* THE OS, at the length a row can carry. The machine's own name for itself is the good answer — "Windows 11 Pro",
 * "Ubuntu 24.04.1 LTS" — and it arrives with a build or kernel version in parentheses, which is precise and often
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

/* THE REST OF WHAT IS KNOWN, as one wrapping line of parts.
 *
 * Ordered by what a reader is looking for: how this sandbox reaches the machine at all (two independent doors, and
 * a box may be behind both), then the two facts that decide how work on it behaves, then who it thinks it is, then
 * which agents are on it — an old one explains a row that lacks what newer machines show, which is the same
 * argument the report's own `agents` field makes.
 *
 * A version is labelled by ITS DOOR rather than by its binary: "desktop sync" and "connected computer" are the
 * names this tab already uses for the two ways in, so "sync agent" and "computer agent" need no explaining.
 *
 * `last seen` appears only when the machine is NOT here now. On a live row it is noise the badge already carries;
 * on an offline one it is the single most useful thing left to say, because "asleep since this morning" and
 * "gone since April" are different situations wearing the same grey badge. */
export const computerDetails = (computer: Computer): string[] => {
    const parts: string[] = [];
    if (computer.syncEnrolled) {
        parts.push(`desktop sync`);
    }
    if (computer.hostId !== undefined) {
        parts.push(`connected computer`);
    }
    if (computer.facts !== undefined) {
        parts.push(computer.facts.arch, computer.facts.shell);
    }
    // The machine's own name for itself, and only when the row is showing something else: the label is the
    // enrolled machine's name or the capability id the user typed, and either can differ from the hostname the
    // machine answers to — which is the name that turns up in its own logs and terminals.
    const hostname = computer.report?.hostname;
    if (hostname !== undefined && hostname.toLowerCase() !== computer.label.toLowerCase()) {
        parts.push(`hostname ${hostname}`);
    }
    const sync = computer.report?.agents.sync;
    if (sync !== undefined) {
        parts.push(`sync agent ${sync}`);
    }
    const computerAgent = computer.hostAgent ?? computer.report?.agents.host;
    if (computerAgent !== undefined) {
        parts.push(`computer agent ${computerAgent}`);
    }
    if (computer.online === false && computer.lastSeen !== undefined) {
        parts.push(`last seen ${timeAgo(computer.lastSeen)}`);
    }
    return parts;
};
