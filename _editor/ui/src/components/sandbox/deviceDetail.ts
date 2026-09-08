// Derivations behind DeviceDetail.vue: what one device is doing for a sandbox, arranged the way it's read.
// The report arrives as two flat lists tagged by sandbox id; folded here into one block per sandbox so
// grouping doesn't fall to the template. Shapes are structural: a DeviceReport satisfies these by shape.

export interface DevicePortRow {
    port: number;
    sandboxId: string;
    state: `mirrored` | `held-by-sandbox` | `busy`;
    heldBy?: string | undefined;
    command?: string | undefined;
    // Which stack the sandbox's listener answered on; never rendered, but lets a dual-stack pair be
    // recognised as one port.
    host?: string | undefined;
}

// One stuck path and what happened on each side; structural, like everything here. Either side absent
// means the machine reported no change kind for it, not that it was untouched.
export interface DeviceConflictRow {
    path: string;
    local?: `created` | `modified` | `deleted` | undefined;
    sandbox?: `created` | `modified` | `deleted` | undefined;
}

export interface DeviceFolderRow {
    sandboxId: string;
    mode: `sync` | `mirror`;
    localDir?: string | undefined;
    // Whether ports are put on localhost; absent means on. An empty port list can mean this, or that
    // nothing is served.
    mirroring?: `on` | `off` | undefined;
    mutagenStatus?: string | undefined;
    conflicts?: number | undefined;
    // Which paths those conflicts are on, as many as the report carries; absent from an agent too old to
    // read them off Mutagen.
    conflictedPaths?: readonly DeviceConflictRow[] | undefined;
    paused?: boolean | undefined;
    // The second session's word, the one-way mirror carrying the sandbox's own state down; see `backupState`.
    backupStatus?: string | undefined;
}

// The agent, in the three states a reader can act on. `stalled` is decided by the caller (see
// `agentStalled` in the sandbox contract), so browser and terminal can't disagree about one machine.
export interface DeviceAgentState {
    running: boolean;
    stalled?: boolean | undefined;
    pid?: number | undefined;
    // The build serving now, and the newer one installed beside it, when a machine hasn't picked up an update yet.
    // Optional: a loop old enough to predate the build stamp reports no build at all, while still running.
    staleBuild?: { readonly running: string | undefined; readonly installed: string } | undefined;
}

// One container's share of its machine right now: caps, whether privileged, whether the GPU rides along,
// and who asked for each privilege (`overlayRuntime`: the approved environment; `hostRuntime`: the owner).
export interface DeviceSandboxResources {
    /** The memory ceiling in bytes; absent when docker imposes none. */
    memoryBytes?: number | undefined;
    /** The CPU ceiling in cores; absent when the container may use every core (the default). */
    cpus?: number | undefined;
    privileged: boolean;
    gpu: boolean;
    hostRuntime: readonly string[];
    overlayRuntime: readonly string[];
}

// One sandbox container on the machine, the docker half of the sandbox the two lists above describe.
export interface DeviceSandboxRow {
    slug: string;
    name?: string | undefined;
    running: boolean;
    image: string;
    tunnelRunning?: boolean | undefined;
    // Its share of the machine, when the caller inspected the container for it; absent from a `docker
    // ps`-only reader.
    resources?: DeviceSandboxResources | undefined;
}

// One line, e.g. "12 GiB · 4 CPUs · privileged · GPU"; only what was set is said, since every core is
// the resting state and needs no words.
const GIB = 1024 ** 3;
const gibOf = (bytes: number): string => {
    const value = bytes / GIB;
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
};

export const resourcesSummary = (row: DeviceSandboxRow): string | undefined => {
    const share = row.resources;
    if (share === undefined) {
        return undefined;
    }
    const parts = [
        ...(share.memoryBytes === undefined ? [] : [`${gibOf(share.memoryBytes)} GiB`]),
        ...(share.cpus === undefined ? [] : [`${share.cpus} ${share.cpus === 1 ? `CPU` : `CPUs`}`]),
        ...(share.privileged ? [`privileged`] : []),
        ...(share.gpu ? [`GPU`] : []),
    ];
    return parts.length === 0 ? undefined : parts.join(` · `);
};

// One sandbox's share of the machine: its container, its folder if it syncs one, and every port it asked for.
export interface DeviceSandboxGroup {
    sandboxId: string;
    /** What to call it, see `titled`: the most human of the names this sandbox goes by. */
    title: string;
    /** The exact id, when the title is NOT it; rendered small beside the title so it's still on screen. */
    subtitle?: string | undefined;
    sandbox?: DeviceSandboxRow | undefined;
    folder?: DeviceFolderRow | undefined;
    ports: DevicePortRow[];
}

// A port that never reached localhost sorts to the bottom; within a group, number order is how people
// look one up.
const byOutcomeThenNumber = (a: DevicePortRow, b: DevicePortRow): number =>
    a.state === b.state ? a.port - b.port : a.state === `mirrored` ? -1 : 1;

// IPv4 and IPv6 binds of the same server are one port to the reader; folded here since the outcome
// (which both rows agree on) is what survives.
const twinKey = (port: DevicePortRow): string => `${port.port}:${port.state}:${port.heldBy ?? ``}:${port.command ?? ``}`;

// The sync agent keys a sandbox by its flattened host (`sandbox-<id>-<name>`); docker knows it by the
// leading label alone (`sandbox-<id>`). Matched conservatively: equal, or continuing past the slug at a separator.
const isSameSandbox = (sandboxId: string, slug: string): boolean => sandboxId === slug || sandboxId.startsWith(`${slug}-`);

// Most-human-first: a recorded display name, then the synced folder's own leaf, then the raw id. The
// exact id survives as `subtitle` rather than being replaced, since it's the string somebody actually types.
const leafOf = (dir: string | undefined): string | undefined => {
    const trimmed = (dir ?? ``).replace(/[/\\]+$/, ``);
    const leaf = trimmed.slice(Math.max(trimmed.lastIndexOf(`/`), trimmed.lastIndexOf(`\\`)) + 1);
    // A drive root (`C:\`) leaves something shaped like a name but meaning nothing about this sandbox.
    return leaf === `` || leaf.endsWith(`:`) ? undefined : leaf;
};

const titled = (
    exact: string,
    sandbox: DeviceSandboxRow | undefined,
    folder: DeviceFolderRow | undefined,
): Pick<DeviceSandboxGroup, `title` | `subtitle`> => {
    const title = sandbox?.name ?? leafOf(folder?.localDir) ?? exact;
    return { title, ...(title === exact ? {} : { subtitle: exact }) };
};

// Driven by the pairings, in their own order, since that's what the user set up and it survives a
// restart with nothing re-mirrored yet. Containers with no pairing come last.
export const sandboxGroups = (
    pairings: readonly DeviceFolderRow[],
    ports: readonly DevicePortRow[],
    sandboxes: readonly DeviceSandboxRow[] = [],
): DeviceSandboxGroup[] => {
    const ids = [...new Set([...pairings.map((folder) => folder.sandboxId), ...ports.map((port) => port.sandboxId)])];
    const paired = ids.map((sandboxId): DeviceSandboxGroup => {
        const seen = new Set<string>();
        const mine: DevicePortRow[] = [];
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
        .map((sandbox): DeviceSandboxGroup => {
            const { title, subtitle } = titled(sandbox.slug, sandbox, undefined);
            const group: DeviceSandboxGroup = { sandboxId: sandbox.slug, title, sandbox, ports: [] };
            if (subtitle !== undefined) {
                group.subtitle = subtitle;
            }
            return group;
        });
    return [...paired, ...unpaired];
};

// Whether a device is put off this sandbox's ports; absent reads as on, what every agent older than this
// switch reports. An empty port list alone can't distinguish this from nothing being served.
export const mirroringOff = (folder: DeviceFolderRow | undefined): boolean => folder?.mirroring === `off`;

// What a sync is doing, in Mutagen's own words rather than mapped onto a traffic light: its halted
// states name their own cause. Paused wins, since it's the one state the user chose.
export const folderState = (folder: DeviceFolderRow): string | undefined => {
    // A mirror enrollment has no session to be in a state; the row already says so in words.
    if (folder.mode === `mirror`) {
        return undefined;
    }
    if (folder.paused === true) {
        return `paused`;
    }
    return folder.mutagenStatus;
};

// Whether this sandbox's state is kept anywhere else; the one row where an absence must be louder than
// any word Mutagen could return. Undefined for a mirror or a paused pairing: neither is a backup that failed.
export const backupState = (folder: DeviceFolderRow): string | undefined => {
    if (folder.mode === `mirror` || folder.paused === true) {
        return undefined;
    }
    return folder.backupStatus ?? `not backed up`;
};

// Only two answers, unlike `folderTone`'s three: a backup is either running or a gap worth acting on.
export const backupTone = (state: string | undefined): `success` | `warning` | `neutral` =>
    state === undefined ? `neutral` : state === `watching` ? `success` : `warning`;

// The tint on that word, not a translation of it: only `watching` (settled) and any `halted-…` (stopped)
// are knowable from outside Mutagen's state machine; everything else stays neutral.
export const folderTone = (state: string | undefined): `success` | `warning` | `neutral` =>
    state === `watching` ? `success` : state?.startsWith(`halted`) === true ? `warning` : `neutral`;

// What a conflict actually is, since a bare count names no file, cause or remedy. Says what happened,
// what it costs (nothing overwritten, just paused), and what ends it, then the paths.
const CONFLICT_ROWS_MAX = 6;

type ConflictChange = NonNullable<DeviceConflictRow[`local`]>;

const ON_DEVICE: Record<ConflictChange, string> = {
    created: `created on this device`,
    modified: `changed on this device`,
    deleted: `deleted on this device`,
};

const IN_SANDBOX: Record<ConflictChange, string> = {
    created: `created in the sandbox`,
    modified: `changed in the sandbox`,
    deleted: `deleted in the sandbox`,
};

export interface ConflictLine {
    /** The lead counts conflicts, never rows: the machine and Mutagen both cap what they report. */
    readonly path: string;
    /** Relative to the synced folder, so it reads the same against the path above and against /work. */
    readonly note: string;
}

export interface FolderConflicts {
    /** What happened on each side, as far as the machine reported it; empty when it reported neither. */
    readonly lead: string;
    readonly rows: readonly ConflictLine[];
    /** The sentence over the list: what happened to those files, and what ends it. */
    readonly more: number;
    // How many conflicts these rows do NOT account for, counted against the machine's own total.
    readonly note?: string;
}

const conflictLine = (conflict: DeviceConflictRow): ConflictLine => ({
    // Why there's no list at all: an agent older than the field reports only the count. Absent whenever
    // there is a list, however short.
    path: conflict.path === `` ? `the folder itself` : conflict.path,
    note: [
        conflict.local === undefined ? undefined : ON_DEVICE[conflict.local],
        conflict.sandbox === undefined ? undefined : IN_SANDBOX[conflict.sandbox],
    ]
        .filter((side) => side !== undefined)
        .join(` · `),
});

export const folderConflicts = (folder: DeviceFolderRow | undefined): FolderConflicts | undefined => {
    const count = folder?.conflicts ?? 0;
    if (folder === undefined || count === 0) {
        return undefined;
    }
    const rows = (folder.conflictedPaths ?? []).slice(0, CONFLICT_ROWS_MAX).map(conflictLine);
    return {
        lead:
            `${count === 1 ? `One path changed` : `${count} paths changed`} both on this device and in the sandbox since they last agreed, so ` +
            `neither copy was overwritten and ${count === 1 ? `it has` : `they have`} stopped syncing. Make the two copies match — same ` +
            `contents, or gone on both sides — and syncing resumes on its own.`,
        rows,
        more: count - rows.length,
        ...(rows.length === 0 ? { note: `This device's agent doesn't report which paths they are. Updating it lists them here.` } : {}),
    };
};

// An empty path is the synced folder itself, what Mutagen reports for a root-level conflict.
export interface GroupSummary {
    /**
     * What a folded row still says about itself: facts are counted and uncoloured, warnings are the reason
     * to open it and keep their ink. The same warnings decide which rows open by default (`groupNeedsAttention`).
     */
    readonly facts: readonly string[];
    /** Counted, uncoloured, e.g. "3 ports", "ports only". */
    readonly warnings: readonly string[];
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

// The reasons to open this row, in the ink of a warning.
const summaryFacts = (group: DeviceSandboxGroup): string[] => {
    const facts: string[] = [];
    // Split in two since the halves are read differently and are each several independent rules.
    if (mirroringOff(group.folder)) {
        facts.push(`mirroring off`);
    }
    const reached = group.ports.filter((port) => port.state === `mirrored`).length;
    if (reached > 0) {
        facts.push(plural(reached, `port`, `ports`));
    }
    // A fact, not a warning: the reader chose this. First, since it explains the absence of everything the
    // ports half would otherwise say.
    if (group.folder?.mode === `mirror`) {
        facts.push(`ports only`);
    }
    return facts;
};

const summaryWarnings = (group: DeviceSandboxGroup): string[] => {
    const warnings: string[] = [];
    const missed = group.ports.filter((port) => port.state !== `mirrored`).length;
    // A pairing that syncs nothing is how it was set up, not a fault: one word on the closed line rather
    // than an opened row repeating it.
    if (missed > 0 && !mirroringOff(group.folder)) {
        warnings.push(`${plural(missed, `port`, `ports`)} not on localhost`);
    }
    if (group.folder?.conflicts) {
        warnings.push(plural(group.folder.conflicts, `conflict`, `conflicts`));
    }
    // Silent while mirroring is off: that's not a fault, and the fact above already names the remedy.
    if (group.sandbox?.tunnelRunning === false) {
        warnings.push(`tunnel off`);
    }
    const sync = group.folder === undefined ? undefined : folderState(group.folder);
    if (sync !== undefined && folderTone(sync) === `warning`) {
        warnings.push(sync);
    }
    return warnings;
};

export const groupSummary = (group: DeviceSandboxGroup): GroupSummary => ({ facts: summaryFacts(group), warnings: summaryWarnings(group) });

// A sandbox reached over the user's own proxy has no sidecar at all, which differs from one that's
// down; only the second is worth a word.
export const groupNeedsAttention = (group: DeviceSandboxGroup): boolean => groupSummary(group).warnings.length > 0;

// Who took the port, as a row on this same card: resolves `heldBy` into a group so the note becomes a
// destination, not just a fact. Undefined when the winner isn't on this machine's report.
export const portHolder = (groups: readonly DeviceSandboxGroup[], port: DevicePortRow): DeviceSandboxGroup | undefined =>
    port.heldBy === undefined ? undefined : groups.find((group) => group.sandboxId === port.heldBy);

// Why a port isn't on localhost, each state naming a different remedy: a contested port is freed by
// stopping the sandbox holding it, a busy one by quitting the local process.
// The program's name is the useful part of the sentence, so it goes where the sentence says "who".
// A port lost to another paired sandbox links to the row that holds it, where its Stop button is; one
// lost to a local program has no such remedy to offer.
export const portNote = (port: DevicePortRow, holder?: DeviceSandboxGroup | undefined, program?: string | undefined): string | undefined => {
    if (port.state === `mirrored`) {
        return undefined;
    }
    // The command on a contended port belongs to the sandbox's own listener, never to whoever won the number.
    if (port.heldBy === undefined) {
        return `not on localhost: ${program ?? `another program here`} has it, and keeps it until it stops`;
    }
    return `not on localhost: ${holder?.title ?? port.heldBy} has it`;
};

// The only commands whose real subject is their argument; everything else is named by its own binary.
const INTERPRETERS = new Set([`node`, `bun`, `deno`, `python`, `python3`, `ruby`, `perl`, `php`, `java`, `sh`, `bash`, `zsh`, `pwsh`]);

const leaf = (token: string): string => token.slice(Math.max(token.lastIndexOf(`/`), token.lastIndexOf(`\\`)) + 1);

// What's listening, at the length a row can carry: the full command line pushed the port number off the
// row entirely, so only the program name shows, with the full line one hover away.
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
