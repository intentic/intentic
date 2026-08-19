/* WHAT ONE COMPUTER IS DOING FOR A SANDBOX, arranged the way it is read — the derivations behind
 * MachineDetail.vue.
 *
 * The report arrives as two flat lists, folders and ports, each row tagged with the sandbox it belongs to. That
 * is the right shape to send and the wrong one to read: a machine with two sandboxes on it drew six rows that
 * each restated a thirty-character sandbox id, in the same ink as the path or the port number the reader came
 * for, and the eye had to do the grouping the data already carried. So the lists are folded into one block per
 * sandbox here, where the rule can be read in one place rather than inferred from a template.
 *
 * Shapes are STRUCTURAL rather than the sandbox contract's own types — `@intentic/ui` carries no domain
 * dependency, and a MachineReport satisfies these by shape. */

export interface MachinePortRow {
    port: number;
    sandboxId: string;
    state: `mirrored` | `held-by-sandbox` | `busy`;
    heldBy?: string | undefined;
    command?: string | undefined;
    // Which stack the sandbox's listener answered on. Never rendered — see the twin rule in `sandboxGroups` —
    // but taken so the two rows a dual-stack server produces can be recognised as one port.
    host?: string | undefined;
}

export interface MachineFolderRow {
    sandboxId: string;
    mode: `sync` | `mirror`;
    localDir?: string | undefined;
    mutagenStatus?: string | undefined;
    conflicts?: number | undefined;
    paused?: boolean | undefined;
}

/* The watcher, in the three states a reader can act on. `stalled` is decided by the CALLER rather than derived
 * here: this package stays structural on purpose, and the freshness rule belongs beside the field it ages (see
 * watcherStalled in the sandbox contract) so the browser and the terminal cannot disagree about one machine.
 *
 * It exists at all because "running" was a pid, and a pid is not a pulse: the agent keeps its transport listeners
 * on its own event loop, so a loop that dies leaves a live process mirroring nothing. */
export interface MachineWatcherState {
    running: boolean;
    stalled?: boolean | undefined;
    pid?: number | undefined;
}

/* One sandbox CONTAINER on the machine — the docker half of the same sandbox the two lists above describe. */
export interface MachineSandboxRow {
    slug: string;
    name?: string | undefined;
    running: boolean;
    image: string;
    tunnelRunning?: boolean | undefined;
}

/* ONE SANDBOX'S SHARE OF THE MACHINE — its container, its folder if it syncs one, and every port it asked for. */
export interface MachineSandboxGroup {
    sandboxId: string;
    /** What to call it — see `titled`: the most human of the names this sandbox goes by. */
    title: string;
    /** The exact id, when the title is NOT it. Rendered small beside the title, so the row is scannable and
     *  the string you would actually type is still on screen. */
    subtitle?: string | undefined;
    sandbox?: MachineSandboxRow | undefined;
    folder?: MachineFolderRow | undefined;
    ports: MachinePortRow[];
}

/* A port that did not reach localhost is the row this view exists for, so the losers sort to the bottom rather
 * than being dropped — and inside each group the number orders them, which is how people look a port up. */
const byOutcomeThenNumber = (a: MachinePortRow, b: MachinePortRow): number =>
    a.state === b.state ? a.port - b.port : a.state === `mirrored` ? -1 : 1;

/* IPv4 AND IPv6 ARE ONE PORT TO THE READER. A dev server that binds both stacks is two rows in the report —
 * 127.0.0.1 and ::1, same number, same outcome — and the view has never shown which is which, so they rendered
 * as the same line twice with nothing to tell them apart (and, keyed by sandbox and number, as a duplicate Vue
 * key). Folded here rather than filtered in the template: the fact that survives is the outcome, which both
 * rows agree on, and `localhost` is the name the reader types either way. */
const twinKey = (port: MachinePortRow): string => `${port.port}:${port.state}:${port.heldBy ?? ``}:${port.command ?? ``}`;

/* THE CONTAINER AND THE PAIRING ARE THE SAME SANDBOX, and the two halves of the report name it differently: the
 * sync agent keys its folder and its ports by the sandbox's HOST with the punctuation flattened
 * (`sandbox-0738cd6b5027-intentic-dev`), while docker knows the container by the leading label of that host
 * alone (`sandbox-0738cd6b5027`). So one is the other with a suffix, which is exactly the correspondence the
 * Computers view already trusts when it decides which row is the sandbox you are reading this in.
 *
 * Matched conservatively — equal, or the id continues past the slug at a separator — because the cost of a
 * wrong match is a folder shown against the wrong container, and the cost of a missed one is the pair rendering
 * as two rows, which is what every surface did before this. */
const isSameSandbox = (sandboxId: string, slug: string): boolean => sandboxId === slug || sandboxId.startsWith(`${slug}-`);

/* WHAT TO CALL A SANDBOX, when every name it has is a machine's.
 *
 * A row used to be titled `sandbox-bce57bb9fe3b`, and a machine running four of them drew four titles that
 * differed only in a blob of hex — so the list could not be scanned at all, and the reader fell through to the
 * folder path underneath to work out which was which. That path is where the readable name was the whole time:
 * its last segment is what the user called the project (`radarsu-web-platform-bce57bb9fe3b`).
 *
 * So the order is most-human-first: the display name a machine recorded, then the folder's own leaf, then the
 * ids. The exact id survives as `subtitle` rather than being replaced — it is the string somebody types into a
 * terminal, and a view that shows only a friendly name makes that string unfindable. */
const leafOf = (dir: string | undefined): string | undefined => {
    const trimmed = (dir ?? ``).replace(/[/\\]+$/, ``);
    const leaf = trimmed.slice(Math.max(trimmed.lastIndexOf(`/`), trimmed.lastIndexOf(`\\`)) + 1);
    // A drive root ("C:\") leaves something shaped like a name and meaning nothing about this sandbox.
    return leaf === `` || leaf.endsWith(`:`) ? undefined : leaf;
};

const titled = (
    exact: string,
    sandbox: MachineSandboxRow | undefined,
    folder: MachineFolderRow | undefined,
): Pick<MachineSandboxGroup, `title` | `subtitle`> => {
    const title = sandbox?.name ?? leafOf(folder?.localDir) ?? exact;
    return { title, ...(title === exact ? {} : { subtitle: exact }) };
};

/* The report's lists, folded into one block per sandbox.
 *
 * Driven by the PAIRINGS, in their own order: a pairing is what the user set up, and it stays on screen through
 * a restart that has not re-mirrored a single port yet. A sandbox that appears only in the port list still gets
 * a block — a report that lists a port for a pairing it did not send is a report worth showing as it is, not
 * one worth silently dropping half of. Containers come last, and only the ones nothing was paired with: a
 * machine runs sandboxes this one has never heard of, and they are still sandboxes on that computer. */
export const sandboxGroups = (
    pairings: readonly MachineFolderRow[],
    ports: readonly MachinePortRow[],
    sandboxes: readonly MachineSandboxRow[] = [],
): MachineSandboxGroup[] => {
    const ids = [...new Set([...pairings.map((folder) => folder.sandboxId), ...ports.map((port) => port.sandboxId)])];
    const paired = ids.map((sandboxId): MachineSandboxGroup => {
        const seen = new Set<string>();
        const mine: MachinePortRow[] = [];
        for (const port of ports) {
            if (port.sandboxId === sandboxId && !seen.has(twinKey(port))) {
                seen.add(twinKey(port));
                mine.push(port);
            }
        }
        const sandbox = sandboxes.find((box) => isSameSandbox(sandboxId, box.slug));
        const folder = pairings.find((entry) => entry.sandboxId === sandboxId);
        return {
            sandboxId,
            ...titled(sandbox?.slug ?? sandboxId, sandbox, folder),
            ...(sandbox === undefined ? {} : { sandbox }),
            folder,
            ports: mine.toSorted(byOutcomeThenNumber),
        };
    });
    const unpaired = sandboxes
        .filter((box) => !ids.some((sandboxId) => isSameSandbox(sandboxId, box.slug)))
        .map((sandbox): MachineSandboxGroup => {
            const { title, subtitle } = titled(sandbox.slug, sandbox, undefined);
            const group: MachineSandboxGroup = { sandboxId: sandbox.slug, title, sandbox, ports: [] };
            if (subtitle !== undefined) {
                group.subtitle = subtitle;
            }
            return group;
        });
    return [...paired, ...unpaired];
};

/* What a file sync is doing, in Mutagen's own words. Not mapped onto a traffic light: its halted states name
 * their own cause ("halted-on-root-emptied"), and flattening them to "problem" sends the reader back to the
 * terminal this view replaces. Paused wins, because it is the one state the user chose. */
export const folderState = (folder: MachineFolderRow): string | undefined => {
    // A mirror enrollment has no session to be in a state, and the row already says so in words — a "ports only"
    // chip beside "no folder — this computer only mirrors ports" is the same fact twice.
    if (folder.mode === `mirror`) {
        return undefined;
    }
    if (folder.paused === true) {
        return `paused`;
    }
    return folder.mutagenStatus;
};

/* The TINT on that word — which is not the same as translating it. Mutagen's vocabulary stays verbatim; all
 * this decides is whether the word reads as settled, as busy, or as something to look at. Only two of them are
 * knowable from outside its state machine: `watching` is the resting state of a healthy session, and anything
 * `halted-…` is a session that has stopped. Everything in between (scanning, transitioning, paused, and any
 * word a later Mutagen invents) stays neutral rather than being guessed at. */
export const folderTone = (state: string | undefined): `success` | `warning` | `neutral` =>
    state === `watching` ? `success` : state?.startsWith(`halted`) === true ? `warning` : `neutral`;

/* WHAT A FOLDED ROW SAYS ABOUT ITSELF — the whole reason folding is safe at all.
 *
 * A list that hides four sandboxes behind four chevrons only beats the wall it replaced if the CLOSED line still
 * answers "is this one fine". So each row carries two kinds of thing, kept apart because they are read
 * differently: FACTS are counted at a glance and never coloured, WARNINGS are the reason to open the row and
 * keep their ink.
 *
 * The warnings are also the open-by-default rule (`groupNeedsAttention`), which is why both live here rather
 * than in a template: "what is wrong with this sandbox" and "which rows start open" have to be ONE answer, or a
 * row warns in its summary and stays shut. */
export interface GroupSummary {
    /** Counted, uncoloured — "3 ports", "ports only". */
    readonly facts: readonly string[];
    /** The reasons to open this row, in the ink of a warning. */
    readonly warnings: readonly string[];
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

export const groupSummary = (group: MachineSandboxGroup): GroupSummary => {
    const facts: string[] = [];
    const warnings: string[] = [];
    const reached = group.ports.filter((port) => port.state === `mirrored`).length;
    const missed = group.ports.length - reached;
    if (reached > 0) {
        facts.push(plural(reached, `port`, `ports`));
    }
    // A pairing that syncs nothing is a fact about how it was SET UP, not a fault — one word on the closed line
    // rather than an opened row whose Folder line says the same thing in eight.
    if (group.folder?.mode === `mirror`) {
        facts.push(`ports only`);
    }
    if (missed > 0) {
        warnings.push(`${plural(missed, `port`, `ports`)} not on localhost`);
    }
    if (group.folder?.conflicts) {
        warnings.push(plural(group.folder.conflicts, `conflict`, `conflicts`));
    }
    // A sandbox reached over the user's own proxy has no sidecar AT ALL, which is not the same fact as one that
    // is down — see the field's own note. Only the second is worth a word.
    if (group.sandbox?.tunnelRunning === false) {
        warnings.push(`tunnel off`);
    }
    const sync = group.folder === undefined ? undefined : folderState(group.folder);
    if (sync !== undefined && folderTone(sync) === `warning`) {
        warnings.push(sync);
    }
    return { facts, warnings };
};

/* WHICH ROWS OPEN THEMSELVES. Deliberately NOT "stopped": plenty of sandboxes are stopped on purpose, and a rule
 * that unfolds every one of them hands back the wall this view exists to fold away. What opens is what somebody
 * has to go and DO something about — and it is the same list the closed line just showed, so a row can never
 * warn and stay shut. */
export const groupNeedsAttention = (group: MachineSandboxGroup): boolean => groupSummary(group).warnings.length > 0;

/* WHO TOOK THE PORT, as a row on this same card.
 *
 * `heldBy` is the winning pairing's sandbox id — the same key every group here is built on — so the sandbox that
 * beat this one is, almost always, a block the reader can already see. Resolving it turns the note from a fact
 * into a destination: the holder's row is where its container's Stop button lives, which is the one gesture that
 * actually frees the number. Undefined when the winner is not on this machine's report (a stale reading, a
 * pairing since removed), and the note falls back to naming it in words. */
export const portHolder = (groups: readonly MachineSandboxGroup[], port: MachinePortRow): MachineSandboxGroup | undefined =>
    port.heldBy === undefined ? undefined : groups.find((group) => group.sandboxId === port.heldBy);

/* WHY A PORT IS NOT ON LOCALHOST. Each state names a DIFFERENT remedy, which is the whole reason they are not
 * one "unavailable": a contested port is freed by stopping or unpairing the sandbox that holds it, a busy one by
 * quitting whatever local process does. Said as a sentence about localhost because the chip beside it no longer
 * claims one — a port that never made it is shown as a bare number, not as an address nobody can open.
 *
 * NAMED THE WAY THE READER NAMES IT. `heldBy` is an id (`sandbox-0738cd6b5027-intentic-dev`), and printing it
 * raw asked someone to recognise a string they have never typed; where the holder is a block on this card, its
 * own title is the name on that block and on the switcher. The id survives as the fallback — a wrong-looking
 * name is worse than an unfamiliar one. */
/* ONE SENTENCE, AND THE PROGRAM IS IN IT. The note used to end at "another program on this computer already has
 * it" and the program's own name was appended AFTER it in a second font — eleven words of prose plus a mono
 * suffix, on a line whose neighbours are addresses. The name is the useful half, so it goes where the sentence
 * says "who", and the rest gets out of the way. */
export const portNote = (port: MachinePortRow, holder?: MachineSandboxGroup | undefined, program?: string | undefined): string | undefined => {
    if (port.state === `mirrored`) {
        return undefined;
    }
    // The command on a contended port belongs to the SANDBOX's own listener, not to whoever won the number, so
    // it is never the answer to "who has it" — only a busy port's command is the program holding it.
    if (port.heldBy === undefined) {
        return `not on localhost — ${program ?? `another program here`} has it`;
    }
    return `not on localhost — ${holder?.title ?? port.heldBy} has it`;
};

// Interpreters are the only commands whose real subject is their ARGUMENT: `node` on its own says nothing about
// which of the four node processes this is. Everything else is named by its binary, because guessing which
// argument matters goes wrong the moment a flag takes a path as its value (`docker run -v /a:/b image`).
const INTERPRETERS = new Set([`node`, `bun`, `deno`, `python`, `python3`, `ruby`, `perl`, `php`, `java`, `sh`, `bash`, `zsh`, `pwsh`]);

const leaf = (token: string): string => token.slice(Math.max(token.lastIndexOf(`/`), token.lastIndexOf(`\\`)) + 1);

/* WHAT IS LISTENING, at the length a row can carry.
 *
 * The report carries the whole command line, and a whole command line is where this view's width went: the
 * process behind a mirrored port arrives as `/usr/bin/docker-proxy -proto tcp -host-ip 0.0.0.0 -host-port 5440
 * -container-ip 172.18.0.2 …`, which pushed the port number it belongs to onto a line of its own and then got
 * cut off mid-flag anyway. What a reader wants from it is recognition — "that's my dev server", "that's the
 * database" — so the row shows the program, and the full line stays one hover away. */
export const shortCommand = (command: string | undefined): string | undefined => {
    const tokens = (command ?? ``).trim().split(/\s+/).filter(Boolean);
    const binary = leaf(tokens[0] ?? ``);
    if (binary === ``) {
        return undefined;
    }
    if (!INTERPRETERS.has(binary.replace(/\.exe$/, ``))) {
        return binary;
    }
    const script = tokens.slice(1).find((token) => !token.startsWith(`-`));
    return script === undefined ? binary : `${binary} ${leaf(script)}`;
};
