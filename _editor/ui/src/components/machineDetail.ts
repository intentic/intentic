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

export interface MachineWatcherState {
    running: boolean;
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
    /** What to call it: the container's display name where there is one, else the id the sync agent knows. */
    title: string;
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
        return {
            sandboxId,
            title: sandbox?.name ?? sandbox?.slug ?? sandboxId,
            ...(sandbox === undefined ? {} : { sandbox }),
            folder: pairings.find((folder) => folder.sandboxId === sandboxId),
            ports: mine.toSorted(byOutcomeThenNumber),
        };
    });
    const unpaired = sandboxes
        .filter((box) => !ids.some((sandboxId) => isSameSandbox(sandboxId, box.slug)))
        .map((sandbox): MachineSandboxGroup => ({ sandboxId: sandbox.slug, title: sandbox.name ?? sandbox.slug, sandbox, ports: [] }));
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

/* WHY A PORT IS NOT ON LOCALHOST. Each state names a DIFFERENT remedy, which is the whole reason they are not
 * one "unavailable": a contested port is freed by unpairing a sandbox, a busy one by quitting whatever local
 * process holds it. Said as a sentence about localhost because the chip beside it no longer claims one — a port
 * that never made it is shown as a bare number, not as an address nobody can open. */
export const portNote = (port: MachinePortRow): string | undefined => {
    if (port.state === `mirrored`) {
        return undefined;
    }
    return port.heldBy === undefined
        ? `not on localhost — another program on this computer already has it`
        : `not on localhost — ${port.heldBy} got there first`;
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
