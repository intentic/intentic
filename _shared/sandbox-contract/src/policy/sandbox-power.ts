import { inertRegions, isLive } from "../text/shell-regions.js";
import type { CommandSpan } from "./command-classes.js";

// A SHELL COMMAND THAT STARTS, STOPS OR REPLACES A SANDBOX CONTAINER (2026-10-12). `ic sandbox restart work` and
// `docker stop intentic-sandbox-work` end the same turns the device tools manage_sandbox and swap_sandbox end, but they
// arrive as text in run_command, where no tool name says what they are. This reads that text once, for both ends that
// have to answer it: the daemon, which asks the owner before an agent cuts the sandbox it runs in while others are
// working (hosts/host-restart-guard.ts), and the device agent, whose "Manage sandboxes" switch decides whether anything
// may do this at all (the machine's tools/shell.ts). The same verbs and the same wording, so a command and the tool
// that does the same job cannot drift apart.
//
// (2026-10-13) On Intentic OS the machine itself is managed the same way: `ic os update|rollback|reboot|channel`, and the
// `bootc upgrade|switch|rollback` under it, change what the whole box boots, and the ones that reboot it stop every
// sandbox on it at once. They are read here as the os_* device tools' twins, under the same switch.

/** The sandbox operations a command can name, in the words `ic sandbox` spells them, and the OS ones in `ic os`'s. */
export type SandboxPowerOp =
    | "start"
    | "stop"
    | "restart"
    | "sleep"
    | "remove"
    | "update"
    | "prepare"
    | "rebuild"
    | "rollback"
    | "dev"
    | "resize"
    | "restore"
    | "connect"
    // The machine's OS (Intentic OS), in `ic os`'s verbs; a bootc spelling reads as the same op.
    | "os-update"
    | "os-rollback"
    | "os-reboot"
    | "os-channel";

/** The owner's own word for an operation, as a card or a refusal says it ("<doing> this sandbox now?"). */
export const SANDBOX_POWER_DOING = {
    start: "Start",
    stop: "Stop",
    restart: "Restart",
    sleep: "Stop",
    remove: "Remove",
    update: "Update",
    prepare: "Prepare an update for",
    rebuild: "Rebuild",
    rollback: "Roll back",
    dev: "Update",
    resize: "Restart with new resources",
    restore: "Restore a backup over",
    connect: "Reinstall",
    // The OS ops stop a sandbox only when they reboot, which takes every sandbox on the machine with it.
    "os-update": "Update and reboot the machine running",
    "os-rollback": "Roll back and reboot the machine running",
    "os-reboot": "Reboot the machine running",
    "os-channel": "Switch images and reboot the machine running",
} as const satisfies Record<SandboxPowerOp, string>;

/** One command that manages a sandbox container, and what it aims at. */
export interface SandboxPowerCommand {
    /** `ic` for `ic sandbox` and `ic os`, `bootc` for the OS's own tool under `ic os`. */
    readonly via: "ic" | "docker" | "bootc";
    readonly op: SandboxPowerOp;
    /** Whether it ends the turns of a sandbox that is running; false for a start, a download, a resource ask saved for later. */
    readonly stops: boolean;
    /** The slugs (`ic`) or container names (`docker`) it names, as written; an expansion (`$x`, `$(…)`, `*`) stays as typed. */
    readonly targets: readonly string[];
    /** Names none: `ic sandbox restart` alone (the only sandbox the device runs), `remove --all`, `docker stop` fed from a pipe, and every OS op, which is the whole machine's. */
    readonly unnamed: boolean;
    /** The fragment, so a card can point at it. */
    readonly span: CommandSpan;
    /** Whether a shell would run it, as against a quoted argument of echo or a comment. */
    readonly live: boolean;
}

// `ic sandbox <verb>`: the program may be a full path, `ic.exe`, or quoted (`& 'C:\…\ic.exe' sandbox restart work`).
const IC_INVOCATION = /(?<![\w.$-])ic(?:\.exe)?["']?\s+sandbox\s+([a-z][a-z-]*)(?![\w-])/gi;
// `docker stop`, `docker container rm`, podman alike. A global option between the program and the verb
// (`docker -H host stop x`) is not read: the verb then follows an option, and the command is left unrecognised.
const DOCKER_INVOCATION = /(?<![\w.$-])(?:docker|podman)(?:\.exe)?["']?\s+(?:container\s+)?(stop|restart|rm|remove|kill)(?![\w-])/gi;
// `ic os <verb>` and `bootc <verb>`, the machine's OS. Only the verbs that change what it boots; `status`, `health`,
// `record` and `pair` read or set up and are left alone, as is a `--check` that only asks the registry.
const IC_OS_INVOCATION = /(?<![\w.$-])ic(?:\.exe)?["']?\s+os\s+([a-z][a-z-]*)(?![\w-])/gi;
const BOOTC_INVOCATION = /(?<![\w.$-])bootc["']?\s+([a-z][a-z-]*)(?![\w-])/gi;

const IC_VERBS = new Map<string, SandboxPowerOp>([
    ["start", "start"],
    ["stop", "stop"],
    ["restart", "restart"],
    ["sleep", "sleep"],
    ["remove", "remove"],
    ["rm", "remove"],
    ["update", "update"],
    ["prepare", "prepare"],
    ["rebuild", "rebuild"],
    ["rollback", "rollback"],
    ["dev", "dev"],
    ["reshape", "resize"],
    ["shape", "resize"],
    ["backup-restore", "restore"],
    ["connect", "connect"],
]);

const DOCKER_VERBS = new Map<string, SandboxPowerOp>([
    ["stop", "stop"],
    ["kill", "stop"],
    ["restart", "restart"],
    ["rm", "remove"],
    ["remove", "remove"],
]);

const IC_OS_VERBS = new Map<string, SandboxPowerOp>([
    ["update", "os-update"],
    ["rollback", "os-rollback"],
    ["reboot", "os-reboot"],
    ["channel", "os-channel"],
]);

// `bootc switch` is what `ic os channel` runs, to any image; `update` is read as `upgrade`'s other spelling.
const BOOTC_VERBS = new Map<string, SandboxPowerOp>([
    ["upgrade", "os-update"],
    ["update", "os-update"],
    ["switch", "os-channel"],
    ["rollback", "os-rollback"],
]);

// The flags of each program that take their value as the next word, so the value is not read as a slug.
const IC_VALUE_FLAGS: ReadonlySet<string> = new Set([
    "--channel",
    "--to",
    "--set",
    "--when",
    "--memory",
    "--cpus",
    "--privileged",
    "--gpus",
    "--idle",
    "--source",
    "--code",
    "--snapshot",
    "--into",
    "--confirm",
    "--accept",
    "--tail",
]);
const DOCKER_VALUE_FLAGS: ReadonlySet<string> = new Set(["-t", "--time", "-s", "--signal"]);
const OS_VALUE_FLAGS: ReadonlySet<string> = new Set(["--wait", "--transport", "--target-imgref"]);

// The simple command that starts the text: up to the first `|`, `;`, `&` or newline outside quotes. A `&` right after
// `>` or `<` is a redirection (`2>&1`), which ends nothing.
const SIMPLE_COMMAND = /^(?:[^|;&\n\r"']|(?<=[<>])&|"[^"]*"?|'[^']*'?)*/;
// One word, quoted pieces included. Backslashes stay as written: they are Windows path separators as often as escapes,
// and a slug has neither.
const WORD = /(?:[^\s"']|"[^"]*"?|'[^']*'?)+/g;
const REDIRECTION = /^\d*(?:>>?|<)/;
const BARE_REDIRECTION = /^\d*(?:>>?|<)$/;

const wordsOf = (text: string): string[] => [...(SIMPLE_COMMAND.exec(text)?.[0] ?? "").matchAll(WORD)].map((word) => word[0].replace(/["']/g, ""));

// A redirection (`2>&1`, `> log`, `>>out`) is not an operand; a bare `>` takes the word after it with it.
const withoutRedirections = (words: readonly string[]): string[] => {
    const kept: string[] = [];
    let skipNext = false;
    for (const word of words) {
        if (skipNext) {
            skipNext = false;
        } else if (BARE_REDIRECTION.test(word)) {
            skipNext = true;
        } else if (!REDIRECTION.test(word)) {
            kept.push(word);
        }
    }
    return kept;
};

interface Operands {
    readonly positionals: readonly string[];
    /** Flags as written, `--flag=value` split: name → value (undefined for a switch). */
    readonly flags: ReadonlyMap<string, string | undefined>;
}

const operandsOf = (words: readonly string[], valueFlags: ReadonlySet<string>): Operands => {
    const positionals: string[] = [];
    const flags = new Map<string, string | undefined>();
    const list = withoutRedirections(words);
    for (const [index, word] of list.entries()) {
        const equals = word.indexOf("=");
        if (!word.startsWith("-") || word === "-") {
            // The word after a flag that takes a value is that value, not an operand.
            if (!valueFlags.has(list[index - 1] ?? "")) {
                positionals.push(word);
            }
        } else if (word.startsWith("--") && equals !== -1) {
            flags.set(word.slice(0, equals), word.slice(equals + 1));
        } else {
            flags.set(word, valueFlags.has(word) ? list[index + 1] : undefined);
        }
    }
    return { positionals, flags };
};

interface Aim {
    readonly stops: boolean;
    readonly targets: readonly string[];
    readonly all: boolean;
}

// What `ic sandbox <op>` with these operands does to a running sandbox, and which sandboxes it aims at. The verbs that
// restart nothing say so: a start, a download, a resource ask saved for the next restart, a backup restored to a folder.
const icAim = (op: SandboxPowerOp, { positionals, flags }: Operands): Aim => {
    const all = flags.has("--all") || flags.has("-a");
    if (op === "start" || op === "prepare") {
        return { stops: false, targets: positionals, all };
    }
    if (op === "resize") {
        // `reshape --later` and `--forget` save an ask and restart nothing; `shape` restarts only with `--when now`.
        const when = flags.get("--when");
        const saves = flags.has("--later") || flags.has("--forget") || (when !== undefined && when !== "now");
        return { stops: !saves, targets: positionals, all };
    }
    if (op === "restore") {
        // A backup restored into a folder touches no sandbox; `--into <slug>` stops that one to write its volumes.
        const into = flags.get("--into");
        return into === undefined ? { stops: false, targets: [], all: false } : { stops: true, targets: [into], all: false };
    }
    if (op === "connect") {
        return { stops: flags.has("--replace"), targets: [], all: false };
    }
    return { stops: true, targets: positionals, all };
};

// Whether an OS op reboots the machine now, which stops every sandbox on it; undefined for a check that only asks the
// registry, which manages nothing. A reboot always does; the rest stage for the next boot unless told `--apply`.
const osStops = (op: SandboxPowerOp, { flags }: Operands): boolean | undefined => {
    if (op === "os-update" && flags.has("--check")) {
        return undefined;
    }
    return op === "os-reboot" || flags.has("--apply");
};

// The OS ops in `command`, through `ic os` or bootc. Each names the whole machine, so none names a target.
const osPowerCommands = (command: string, via: "ic" | "bootc", regions: readonly CommandSpan[]): SandboxPowerCommand[] =>
    [...command.matchAll(via === "ic" ? IC_OS_INVOCATION : BOOTC_INVOCATION)].flatMap((invocation) => {
        const op = (via === "ic" ? IC_OS_VERBS : BOOTC_VERBS).get((invocation[1] ?? "").toLowerCase());
        const span = { start: invocation.index, end: invocation.index + invocation[0].length };
        const stops = op === undefined ? undefined : osStops(op, operandsOf(wordsOf(command.slice(span.end)), OS_VALUE_FLAGS));
        return op === undefined || stops === undefined ? [] : [{ via, op, stops, targets: [], unnamed: true, span, live: isLive(span, regions) }];
    });

/**
 * Every command in `command` that starts, stops or replaces a sandbox container, through `ic sandbox` or `docker`, or
 * changes what an Intentic OS machine boots, through `ic os` or `bootc`.
 * A scan for the programs by name, not a shell parse: it is meant to over-include, since a caller that mistakes
 * a mention for a command asks the owner once, and one that misses a command cuts a fleet's turns unasked.
 */
export const sandboxPowerCommands = (command: string): SandboxPowerCommand[] => {
    const regions = inertRegions(command);
    const found: SandboxPowerCommand[] = [];
    for (const invocation of command.matchAll(IC_INVOCATION)) {
        const op = IC_VERBS.get((invocation[1] ?? "").toLowerCase());
        if (op !== undefined) {
            const span = { start: invocation.index, end: invocation.index + invocation[0].length };
            const aim = icAim(op, operandsOf(wordsOf(command.slice(span.end)), IC_VALUE_FLAGS));
            found.push({ via: "ic", op, stops: aim.stops, targets: aim.targets, unnamed: aim.targets.length === 0 || aim.all, span, live: isLive(span, regions) });
        }
    }
    found.push(...osPowerCommands(command, "ic", regions), ...osPowerCommands(command, "bootc", regions));
    for (const invocation of command.matchAll(DOCKER_INVOCATION)) {
        const op = DOCKER_VERBS.get((invocation[1] ?? "").toLowerCase());
        if (op !== undefined) {
            const span = { start: invocation.index, end: invocation.index + invocation[0].length };
            const { positionals } = operandsOf(wordsOf(command.slice(span.end)), DOCKER_VALUE_FLAGS);
            found.push({ via: "docker", op, stops: true, targets: positionals, unnamed: positionals.length === 0, span, live: isLive(span, regions) });
        }
    }
    return found.toSorted((left, right) => left.span.start - right.span.start);
};

// A word whose value exists only when the shell runs it: `$(docker ps -q)`, `$NAME`, `*`, PowerShell's `(…)` and `%X%`.
const isExpansion = (word: string): boolean => /[$`*?%]|^\(/.test(word);

/** The sandbox a caller means to protect: its slug, and the container name docker knows it by. */
export interface OwnSandbox {
    readonly slug: string;
    readonly container: string;
}

/**
 * Whether `hit` may stop `own`. Deliberately generous: it names it, names none (the device's only sandbox, `--all`, a
 * pipe), or names something that is only worked out when the command runs. A target spelled as the bare slug counts for
 * `docker` too, which knows the container by a longer name.
 */
export const mayReachSandbox = (hit: SandboxPowerCommand, own: OwnSandbox): boolean =>
    hit.unnamed || hit.targets.some((target) => target === own.slug || target === own.container || isExpansion(target));

/**
 * Whether `hit` manages a sandbox that a device's "Manage sandboxes" switch covers, whichever sandbox it is: any
 * `ic sandbox` or `ic os` verb here and any bootc one (the OS is every sandbox's ground), and a `docker` verb aimed at a
 * container whose name starts with `containerPrefix` (a sandbox's own, or its tunnel's). A docker target worked out at
 * run time is not read: the device cannot know what it will be.
 */
export const managesSandbox = (hit: SandboxPowerCommand, containerPrefix: string): boolean =>
    hit.via !== "docker" || hit.targets.some((target) => target.startsWith(containerPrefix));

/** Whether `hit` acts on the machine's OS (`ic os`, `bootc`) rather than on one sandbox. */
export const isOsPower = (hit: Pick<SandboxPowerCommand, "op">): boolean => hit.op.startsWith("os-");
