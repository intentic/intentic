// What one of the user's own machines is running.
import { z } from "zod";
import { hostEntryOf, hostEnvironmentOf, type DeviceFacts, DeviceFactsSchema, WslEnvironmentSchema } from "./hosts.js";
import { DEV_VERSION } from "../state/versions.js";
// Desktop-sync report shape shared by the agent, daemon and browser, produced only by `intentic-machine status --json`.
// The agent never reports `sandboxes`; the docker half is filled in by whoever reads the report, scoped to the reader's
// own pairing.

// One sandbox's resource share as docker currently enforces it, read off the container by the machine agent.
// `overlayRuntime` is the environment's locked demand; `hostRuntime` is the owner's addition; `privileged`/`gpu` are
// docker's enforced truth.
export const SandboxResourcesSchema = z.object({
    // The cgroup memory ceiling in bytes; absent when docker imposes none (the hosted shape).
    memoryBytes: z.number().optional(),
    // The CFS quota as whole cores; absent when the container may use every core (the default).
    cpus: z.number().optional(),
    privileged: z.boolean(),
    gpu: z.boolean(),
    hostRuntime: z.array(z.string()),
    overlayRuntime: z.array(z.string()),
});
export type SandboxResources = z.infer<typeof SandboxResourcesSchema>;

// Reshape request, turned into `ic sandbox reshape` flags: absent means leave it, `null` on the two caps means back to
// the default; at least one key must be set.
export const SandboxResourcesAskFieldsSchema = z.object({
    memoryGib: z.int().positive().nullable().optional(),
    cpus: z.int().positive().nullable().optional(),
    privileged: z.boolean().optional(),
    gpu: z.boolean().optional(),
});
// Fields also exported separately for callers that compose them and enforce the at-least-one rule themselves.
export const SandboxResourcesAskSchema = SandboxResourcesAskFieldsSchema.refine((ask) => Object.values(ask).some((value) => value !== undefined), {
    message: "a reshape must change at least one thing",
});
export type SandboxResourcesAsk = z.infer<typeof SandboxResourcesAskSchema>;

// One sandbox container on the machine, the docker half, filled in by the reader, never by the sync agent.
export const DeviceSandboxSchema = z.object({
    slug: z.string(),
    container: z.string(),
    // The display name, when the machine has one recorded. Docker knows only the container name.
    name: z.string().optional(),
    running: z.boolean(),
    image: z.string(),
    // Absent when there is no cloudflared sidecar at all; that is not the same as a sidecar that is down.
    tunnelRunning: z.boolean().optional(),
    // Absent when the reader only ran a cheap `docker ps` listing without inspecting the container.
    resources: SandboxResourcesSchema.optional(),
});
export type DeviceSandbox = z.infer<typeof DeviceSandboxSchema>;
// One operation on one sandbox, streamed as lines ending in a `result` or `error` frame. `prepare` builds the pending
// update without touching the container; `reshape` changes only its resources and privileges, not the image.
// `runner-up`/`runner-remove` act on a runner (this sandbox's own container), not a person's sandbox; gated by the
// `sandboxes` switch, not removal, since a runner holds no separate workspace to lose.
export const DeviceSandboxOpSchema = z.enum([
    "start",
    "stop",
    "restart",
    "prepare",
    "update",
    "rebuild",
    "rollback",
    "reshape",
    "remove",
    "logs",
    // The two ops that redeem a fresh setup code; every other one recreates a container from its own existing env.
    // They differ only in which row the claim names — an existing sandbox on this machine, or one that has never run
    // anywhere — which is why each checks the opposite thing about the slug before spending the code.
    "reconnect",
    "create",
    "runner-up",
    "runner-remove",
]);
export type DeviceSandboxOp = z.infer<typeof DeviceSandboxOpSchema>;
export const DeviceSandboxFlowSchema = z.object({
    op: DeviceSandboxOpSchema,
    // Sandbox slug, the runner's name for the runner ops (as `/system/runners`/`ic runner list` know it), or for
    // `create` the name the claim is about to produce — the one op where the slug is an expectation rather than a
    // lookup, and the device refuses if anything already answers to it.
    slug: z.string().min(1),
    // Approved overlay's sha256, required only by `rebuild`; only content matching it is ever built.
    hash: z.string().optional(),
    // What `reshape` should change, required by it and meaningless to the rest.
    resources: SandboxResourcesAskSchema.optional(),
    // `runner-up` only, daemon-filled, never by the caller: the browser never holds the pairing credential.
    parentUrl: z.string().optional(),
    pair: z.string().optional().meta({ secret: true }),
    // Required by `reconnect` and `create`; single-sandbox and short-lived, so a leak only buys one recreate.
    setupCode: z.string().optional().meta({ secret: true }),
    // `runner-up` only, daemon-filled: `definition` carries no capabilities or secrets; `overlay`/`overlayHash` are
    // re-verified by hash before build.
    definition: z.string().optional(),
    overlay: z.string().optional(),
    overlayHash: z.string().optional(),
});
export type DeviceSandboxFlow = z.infer<typeof DeviceSandboxFlowSchema>;
// Adds the device id to the flow input; the daemon looks up machines by id.
export const DeviceSandboxFlowInputSchema = DeviceSandboxFlowSchema.extend({ id: z.string().min(1) });
export type DeviceSandboxFlowInput = z.infer<typeof DeviceSandboxFlowInputSchema>;
// Streamed operation output, matching `IntenticLineSchema`: `line` frames as printed, then one terminal frame, `result`
// or `error`, carrying the machine's own message rather than a code.
export const DeviceFlowLineSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("line"), text: z.string() }),
    z.object({ kind: z.literal("result"), message: z.string() }),
    z.object({ kind: z.literal("error"), message: z.string() }),
]);
export type DeviceFlowLine = z.infer<typeof DeviceFlowLineSchema>;
// Every op stops the resident process mid-command; a stream ending with no terminal frame is normal, not a failure, and
// confirmation is the version moving on the next poll. `restart` is just a bare `intentic-machine run`.
// `forget-unreachable` drops the machine's links to sandboxes that have answered nothing for long enough to be gone
// (peer-dial's LONG_OUTAGE_ATTEMPTS) — never the link carrying the request, which is by definition answering.
export const DeviceAgentOpSchema = z.enum(["upgrade", "restart", "forget-unreachable"]);
export type DeviceAgentOp = z.infer<typeof DeviceAgentOpSchema>;
export const DeviceAgentFlowSchema = z.object({ op: DeviceAgentOpSchema });
export type DeviceAgentFlow = z.infer<typeof DeviceAgentFlowSchema>;
// Adds the device id to the flow input.
export const DeviceAgentFlowInputSchema = DeviceAgentFlowSchema.extend({ id: z.string().min(1) });
export type DeviceAgentFlowInput = z.infer<typeof DeviceAgentFlowInputSchema>;
// Closed set of command names; the daemon builds argv from the name alone (hosts/device-commands.ts). Never a free-text
// command: the same socket carries `run_command`, which would grant a shell on the user's machine.
// `sync-unpair` runs the machine's own `sync uninstall --sandbox` (terminates both Mutagen sessions, drops the pairing,
// self-revokes enrollment); revoking from the sandbox side is a different route.
// `dev-restart`, `dev-rebuild` and `sync-install` are the three whose argv the daemon fills from what only it knows — the
// dev checkout on that machine, a freshly minted pairing token — which is also why none takes a path or a token from the
// caller. The two dev commands are also why a machine-side op is the wrong shape for them: this door carries a COMMAND
// STRING to a tool every released agent already has, so a sandbox can drive a machine whose agent predates the feature.
// `dev-rebuild-log` is the read side of `dev-rebuild`: the build is detached out there, so its log is the only place its
// progress exists, and polling this is what turns a fired-and-forgotten command into something with a progress bar.
// `sync-clean` removes the build output left in directories the sandbox has deleted, which is what stops those
// deletions from ever landing. It deletes only content the session already ignores, so it is the one command here whose
// worst outcome is a rebuild — which is why it is a button and not a turn.
// `mirror-ignore`/`mirror-unignore` are `mirror-off`'s per-port form, and the reason they exist: a port number that is
// permanently taken on one machine's localhost has no answer in an all-or-nothing switch, so the choice lives where the
// conflict does — one port, one device, durable — instead of muting every port the pairing serves.
export const DeviceCommandSchema = z.enum([
    "mirror-off",
    "mirror-on",
    "mirror-ignore",
    "mirror-unignore",
    "sync-pause",
    "sync-resume",
    "sync-unpair",
    "sync-clean",
    "dev-restart",
    "dev-rebuild",
    "dev-rebuild-log",
    "sync-install",
]);
export type DeviceCommand = z.infer<typeof DeviceCommandSchema>;
// The reversible sync switches: the subset a device's own row drives with a pair of buttons, as opposed to the two
// commands a card elsewhere issues once. Its own type so those button tables stay total without carrying entries for
// commands they can never send.
export const DeviceSyncSwitchSchema = DeviceCommandSchema.exclude(["dev-restart", "dev-rebuild", "dev-rebuild-log", "sync-install", "sync-clean"]);
export type DeviceSyncSwitch = z.infer<typeof DeviceSyncSwitchSchema>;

// WHERE A DETACHED REBUILD REPORTS ITSELF. `dev-rebuild` returns the moment the build is under way and nothing streams
// back from it — a cold build outruns any timeout this door has, and the container swap at the end kills the daemon that
// would have read the answer — so the build writes here instead, in the folder ic logs its own recreates into, and
// `dev-rebuild-log` reads it back. Spelled once, here, because the daemon builds both command lines from it and the
// browser names the same path to a reader whose rebuild never came back.
export const devRebuildLogPath = (slug: string): string => `~/.intentic/logs/dev-rebuild-${slug}.log`;

// The build's own shell appends this when the build ends, with its exit status: since the log outlives the daemon, the
// container and the page that started it, this mark is the only thing that can say a rebuild is OVER rather than slow.
export const DEV_REBUILD_EXIT_MARK = "@intentic-rebuild-exit";
// `dev-rebuild-log` prints this first, then how many seconds it is since the log last grew — `-` when there is no log on
// that machine at all. A running build goes quiet for a minute at a time inside a docker layer; a build whose machine
// slept never writes its exit mark, and only this tells the two apart.
export const DEV_REBUILD_QUIET_MARK = "@intentic-rebuild-quiet";

export interface DevRebuildLog {
    /** Nothing has ever rebuilt this sandbox from a checkout on that machine. */
    readonly missing: boolean;
    /** Seconds since the log last grew; undefined when the machine's `stat` wouldn't say. */
    readonly quietFor: number | undefined;
    /** The build's own exit status, present only once it has ended. */
    readonly exitCode: number | undefined;
    /** The tail as the machine printed it, both marks removed. */
    readonly lines: readonly string[];
}

// Reads `dev-rebuild-log`'s stdout. Shared rather than parsed at the reader, so the shell line that produces this and the
// card that draws it cannot drift apart. Unparseable is never an error: an answer with no marks at all is simply a log
// with nothing to say yet.
const markValue = (line: string, mark: string): string | undefined => (line.startsWith(`${mark} `) ? line.slice(mark.length + 1).trim() : undefined);
const wholeNumber = (value: string): number | undefined => (/^\d+$/.test(value) ? Number(value) : undefined);

export const readDevRebuildLog = (text: string): DevRebuildLog => {
    let missing = false;
    let quietFor: number | undefined;
    let exitCode: number | undefined;
    const lines: string[] = [];
    for (const line of text.split(/\r?\n/)) {
        const quiet = markValue(line, DEV_REBUILD_QUIET_MARK);
        const exit = markValue(line, DEV_REBUILD_EXIT_MARK);
        if (quiet !== undefined) {
            missing = quiet === "-";
            quietFor = wholeNumber(quiet);
        } else if (exit !== undefined) {
            // A mark whose status is unreadable still means the build ENDED, and not well.
            exitCode = wholeNumber(exit) ?? 1;
        } else {
            lines.push(line);
        }
    }
    while (lines.at(-1)?.trim() === "") {
        lines.pop();
    }
    return { missing, quietFor, exitCode, lines };
};
// Machine's sandbox id (absent = every paired sandbox); must start alphanumeric, else it parses as a CLI flag.
export const DeviceSandboxIdSchema = z
    .string()
    .max(200)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
// A folder on the DEVICE for `sync-install` to keep in step. The only caller-supplied string that reaches a command
// line, so its shape is the guard: `~`, an absolute POSIX path or a drive letter, and none of the characters that would
// end the argument it sits in. `~` is expanded by the daemon, which is why `$` is not allowed to arrive here.
export const DeviceLocalDirSchema = z
    .string()
    .min(1)
    .max(4096)
    .regex(/^(?:~|\/|[A-Za-z]:[\\/])[^"'`$;|&\n\r]*$/);
// A TCP port number, the one value a caller supplies that reaches a command line as a number rather than a string.
export const PortNumberSchema = z.number().int().min(1).max(65535);
export const DeviceCommandInputSchema = z.object({
    id: z.string().min(1),
    command: DeviceCommandSchema,
    sandboxId: DeviceSandboxIdSchema.optional(),
    // `sync-install` only: which half to enroll (a member's "sync" still comes back mirror, decided daemon-side) and,
    // for file sync, the folder on that device. The pairing token is minted by the daemon; no caller ever carries one.
    mode: z.enum(["sync", "mirror"]).optional(),
    localDir: DeviceLocalDirSchema.optional(),
    // The two per-port mirror switches only. A number rather than a string, so nothing a caller sends can widen the
    // command line it lands in.
    port: PortNumberSchema.optional(),
});
export type DeviceCommandInput = z.infer<typeof DeviceCommandInputSchema>;
// `ok` is the command's own exit status, not this route's: a refusal or non-zero exit is a real answer, not a thrown
// error. Only an unreachable machine throws. `output` is the command's own printed text.
export const DeviceCommandResultSchema = z.object({
    ok: z.boolean(),
    message: z.string(),
    output: z.string().optional(),
    // WHICH KIND OF `ok: false` THIS IS, because a caller that repeats itself needs to tell them apart: the device
    // turning the command away (a switch of its own is off, the path is out of its reach) will turn it away again,
    // whereas a command it accepted and then killed at its deadline says nothing except that this attempt was too slow.
    refused: z.boolean(),
});
export type DeviceCommandResult = z.infer<typeof DeviceCommandResultSchema>;

// What one side did to a conflicted path. The first three are Mutagen's own change kinds. `untracked` is its word for
// content it SCANS but never carries — whatever sits under an ignore pattern, which for a workspace means build output
// — and it is the whole difference between a conflict somebody must settle and one a device can clear by itself. Absent
// means Mutagen did not say, not that a side is untouched.
export const DeviceConflictChangeSchema = z.enum(["created", "modified", "deleted", "untracked"]);
export type DeviceConflictChange = z.infer<typeof DeviceConflictChangeSchema>;

// Which of two unlike things this conflict is. `both-edited` is the one the mode exists for: two real copies, one
// choice, a person's. `derived-leftover` is not a disagreement at all — one side deleted a directory, the other still
// holds build output inside it, and Mutagen will not delete a directory whose contents it never carried. Nothing at
// stake, nobody's edit, and no judgement to make.
export const DeviceConflictNatureSchema = z.enum(["derived-leftover", "both-edited"]);
export type DeviceConflictNature = z.infer<typeof DeviceConflictNatureSchema>;

export const DeviceConflictSchema = z.object({
    /** Relative to the synced folder (matches both `localDir` and /work); empty means the root itself. */
    path: z.string(),
    /** What happened on the device (Mutagen's alpha). */
    local: DeviceConflictChangeSchema.optional(),
    /** And in the sandbox's /work (its beta). */
    sandbox: DeviceConflictChangeSchema.optional(),
    // Absent from an agent older than the classification, which is why no reader may treat absence as `both-edited`:
    // `clearableOnDevice` below tests for the derived shape rather than against the other one.
    nature: DeviceConflictNatureSchema.optional(),
});
export type DeviceConflict = z.infer<typeof DeviceConflictSchema>;

// Whether this one is the device's own to clear: build output on the device, inside a directory the sandbox deleted.
// The rule lives here because two sides read it — the machine agent deciding what to remove, and the browser deciding
// whether to offer a button instead of an agent — and they must never disagree about which conflicts need a person.
export const clearableOnDevice = (conflict: DeviceConflict): boolean =>
    conflict.nature === "derived-leftover" && conflict.local === "untracked" && conflict.sandbox === "deleted";

// One paired sandbox as the local agent holds it; `localDir` is which folder on that device holds this sandbox's /work.
export const DevicePairingSchema = z.object({
    sandboxId: z.string(),
    mode: z.enum(["sync", "mirror"]),
    // Set only for mode "sync", and only for the sandbox being reported to.
    localDir: z.string().optional(),
    // Machine-owned switch (agent's own `sync mirror off`); absent reads as "on", not merely unknown.
    mirroring: z.enum(["on", "off"]).optional(),
    // Mutagen's own status word, kept verbatim rather than reduced to a traffic light.
    mutagenStatus: z.string().optional(),
    // Whole conflict count, including any Mutagen's own state truncates (`excludedConflicts`).
    conflicts: z.number().int().nonnegative().optional(),
    // Conflicted paths, capped at `CONFLICT_PATHS_MAX`; `conflicts` above is the true, uncapped count.
    conflictedPaths: z.array(DeviceConflictSchema).optional(),
    paused: z.boolean().optional(),
    // Second session's status (the state-dir backup mirror), reported separately: the two fail independently.
    backupStatus: z.string().optional(),
});
export type DevicePairing = z.infer<typeof DevicePairingSchema>;
// One sandbox port and what became of it on this machine's localhost; carries a state rather than just live forwards,
// since two sandboxes can claim the same port and the loser needs a reason shown.
export const DevicePortStateSchema = z.enum([
    // Forwarded: the sandbox's listener answers on this machine's localhost at the same number.
    "mirrored",
    // Another paired sandbox already holds the port (first paired wins); `heldBy` names it.
    "held-by-sandbox",
    // Something outside this product already binds the port; not ours to name or take.
    "busy",
    // The owner told this device to leave this number alone (`sync mirror ignore`); nothing was attempted.
    "ignored",
]);
export type DevicePortState = z.infer<typeof DevicePortStateSchema>;

// Why a port the sandbox serves is not on this machine's localhost: the state minus its one success. Named here
// because the machine decides it and the browser renders it, so a new reason has to reach both at once.
export const PortSkipReasonSchema = DevicePortStateSchema.exclude(["mirrored"]);
export type PortSkipReason = z.infer<typeof PortSkipReasonSchema>;

export const DevicePortSchema = z.object({
    port: PortNumberSchema,
    host: z.enum(["127.0.0.1", "::1"]),
    // The sandbox serving the port, whose /ports listed it, not whoever ended up holding the local bind.
    sandboxId: z.string(),
    state: DevicePortStateSchema,
    // Set only for "held-by-sandbox": the sandbox id that owns the local bind instead.
    heldBy: z.string().optional(),
    // What is listening on the sandbox side (e.g. `node …/vite`), so the user can recognise it.
    command: z.string().optional(),
});
export type DevicePort = z.infer<typeof DevicePortSchema>;
// The device's one agent process as a single block; `running` also gates whether the rest of the report is still
// current, a dead loop leaves every other row reading as it did before it died.
export const DeviceAgentSchema = z.object({
    running: z.boolean(),
    pid: z.number().int().optional(),
    // Build on disk at `~/.intentic/bin/intentic-machine`; absent means no installed agent at all.
    installed: z.string().optional(),
    // Build actually serving, stamped in the pidfile; can lag `installed` indefinitely (see `agentBuildSkew`).
    build: z.string().optional(),
    // When the loop last finished a pass; a live process can have a dead loop (see `agentStalled`).
    lastTickAt: z.number().optional(),
});
export type DeviceAgent = z.infer<typeof DeviceAgentSchema>;
// Loop polls every 5s with two 10s network timeouts per pairing; a minute is several passes of slack.
export const AGENT_STALL_AFTER_MS = 60_000;
export const agentStalled = (agent: DeviceAgent, now: number): boolean =>
    agent.running && agent.lastTickAt !== undefined && now - agent.lastTickAt > AGENT_STALL_AFTER_MS;
export const DeviceReportSchema = z.object({
    // OS hostname; the join key that dedupes a machine seen via sync and via its `host` capability. Not unique on its
    // own: a WSL distro inherits the Windows machine's name, so `wsl` below is what tells those apart.
    hostname: z.string(),
    os: z.string(),
    // Present only inside a WSL distro; the same fact rides the connect-time facts, which no scope can withhold.
    wsl: WslEnvironmentSchema.optional(),
    pairings: z.array(DevicePairingSchema),
    ports: z.array(DevicePortSchema),
    // The one agent this device runs, on disk and in flight, in one block.
    agent: DeviceAgentSchema,
    // When the machine took this reading, not when the daemon received it; the UI ages the report against this.
    capturedAt: z.number(),
});
export type DeviceReport = z.infer<typeof DeviceReportSchema>;

// Past this, a reading stops speaking for the machine and only says when it was taken. Read against the moment the
// reading was received, never the wall clock: a copy nobody has re-read is old, not evidence the machine went quiet.
export const REPORT_QUIET_AFTER_MS = 60_000;
export const reportQuiet = (report: DeviceReport, receivedAt: number): boolean => receivedAt - report.capturedAt > REPORT_QUIET_AFTER_MS;

// The environment a device's evidence describes, as opposed to the machine hosting it: `wsl:<distro>` inside a
// distro, `native` for an install on the metal. Connect-time facts are read first, since no scope can withhold them;
// facts from an agent too old to carry `hostname` say nothing, and a report without `wsl` is native, as it always
// was. Undefined is an absence of evidence, never read as agreement.
export const environmentOf = (facts: Pick<DeviceFacts, "hostname" | "wsl"> | undefined, report: DeviceReport | undefined): string | undefined => {
    const wsl = facts?.wsl ?? report?.wsl;
    if (wsl !== undefined) {
        return `wsl:${wsl.distro}`;
    }
    return facts?.hostname !== undefined || report !== undefined ? "native" : undefined;
};

// Whether two devices positively disagree about which environment they are. False whenever either side has not said,
// so this only ever blocks a fold it holds evidence against.
export const differentEnvironment = (left: string | undefined, right: string | undefined): boolean =>
    left !== undefined && right !== undefined && left !== right;

// Compares running build against installed; silent when the loop is stopped, nothing installed, or installed is a dev
// build. An unstamped `running` still counts as skew.
export const agentBuildSkew = (agent: DeviceAgent): { readonly running: string | undefined; readonly installed: string } | undefined => {
    const { build: running, installed } = agent;
    if (!agent.running || installed === undefined || installed === DEV_VERSION || running === installed) {
        return undefined;
    }
    return { running, installed };
};

// Why a device that is present has no report; each value is a distinct thing for the reader to do about it.
export const DeviceGapSchema = z.enum([
    // A host capability that is enrolled but has no socket right now. Laptops sleep; this is not a fault.
    "offline",
    // Connected, but "Run commands" is off on its capability card, so it won't describe itself: no folders, no
    // ports, no agent health. Says nothing about its containers, which ride their own switch (`Device.sandboxes`).
    "scope-off",
    // Reachable and asked, but has no `intentic-machine` installed, so nothing knows its folders or ports.
    "no-agent",
    // Sync-enrolled but has not posted a report yet; unlike `no-agent`, the agent is there and syncing.
    "unreported",
]);
export type DeviceGap = z.infer<typeof DeviceGapSchema>;
// A machine may be reachable via desktop sync and a host capability at once; the two are reconciled on `hostname` plus
// the environment it came from (`environmentOf`), and left as separate rows when there is nothing to reconcile them by
// or when the environments positively disagree.
// `machine` is the enrollment's name for the box (the ssh key's comment): what reports are filed under and what the
// revoke route takes. Two machines sharing a key comment share one enrollment identity.
export const DeviceSyncSchema = z.object({
    machine: z.string(),
    // "sync" is files+ports, single-holder per sandbox; "mirror" is ports only, any number of machines.
    mode: z.enum(["sync", "mirror"]),
    // When this machine last used its enrollment; absent means never, not merely unknown, and is not healthy.
    seenAt: z.number().optional(),
});
export type DeviceSync = z.infer<typeof DeviceSyncSchema>;
export const DeviceSchema = z.object({
    // Stable row key: the reported hostname when either door produced one, else the name that door knows it by.
    key: z.string(),
    // What to call it on screen, the user's own name for the machine wherever one exists.
    label: z.string(),
    // Desktop-sync enrollment with this sandbox; absent when reached only via a host capability.
    sync: DeviceSyncSchema.optional(),
    // The host capability's id, when this machine is also a connected device. Absent otherwise.
    hostId: z.string().optional(),
    // Host-capability liveness; absent when there is no host capability, not the same as offline.
    online: z.boolean().optional(),
    // Carried beside the report so a device with no report still has an OS; `platform` is the normalised slug, `facts`
    // its connect-time self-description.
    platform: z.string().optional(),
    facts: DeviceFactsSchema.optional(),
    // Announced at connect; matches `report.agent.build` when known, the only version a report-less device has.
    agentVersion: z.string().optional(),
    lastSeen: z.number().optional(),
    report: DeviceReportSchema.optional(),
    // The containers this machine holds, read through the host door's own `list_sandboxes` and so behind its own
    // switch ("Manage sandboxes on this device", or "Run commands"). Beside the report rather than inside it because
    // the two ride different switches: a card granting sandbox management and nothing else answers this and no
    // report at all. Absent means nobody could look — a sync-only machine, a refusal, an unread device — never that
    // the machine holds none.
    sandboxes: z.array(DeviceSandboxSchema).optional(),
    gap: DeviceGapSchema.optional(),
});
export type Device = z.infer<typeof DeviceSchema>;
export const DevicesListSchema = z.object({ devices: z.array(DeviceSchema) });
export type DevicesList = z.infer<typeof DevicesListSchema>;

// The physical computer a device is an environment of. Windows and every WSL distro on it are one machine with one
// Docker engine, one screen and one set of disks, each environment holding its own agent and its own door.
export interface Machine {
    /** The card its doors hang off, else the hostname they share, else a lone uncarded device's own key. */
    readonly key: string;
    readonly label: string;
    /** Windows first, then distros by the name WSL registered: the side that owns the screen leads. */
    readonly environments: readonly Device[];
}

export const deviceHostname = (device: Device): string | undefined => device.facts?.hostname ?? device.report?.hostname;

// Which side of a machine a device is. Its door id names the environment it connected under (`<card>::wsl:<distro>`),
// and that is all an environment nobody has reached since this daemon booted can say about itself: liveness resets on
// restart, so facts and reports are absent on a side that is merely asleep.
export const deviceEnvironment = (device: Device): string | undefined =>
    environmentOf(device.facts, device.report) ?? (device.hostId === undefined ? undefined : hostEnvironmentOf(device.hostId));

const WSL_PREFIX = "wsl:";
export const isWslDevice = (device: Device): boolean => deviceEnvironment(device)?.startsWith(WSL_PREFIX) === true;
// The distro a device runs, by whatever evidence it holds; absent on a native install and on one that has said nothing.
export const deviceDistro = (device: Device): string | undefined => {
    const environment = deviceEnvironment(device);
    return environment?.startsWith(WSL_PREFIX) === true ? environment.slice(WSL_PREFIX.length) : undefined;
};

// Native first, then distros by the name WSL registered them under rather than by their door id, which is that same
// name behind a card's and so would order a PC's distros by which card each was connected through.
const byEnvironment = (a: Device, b: Device): number =>
    Number(isWslDevice(a)) - Number(isWslDevice(b)) || (deviceDistro(a) ?? a.label).localeCompare(deviceDistro(b) ?? b.label);

const hostnameKey = (device: Device): string | undefined => deviceHostname(device)?.toLowerCase();

// The card a device's door hangs off: one card is one computer, so two doors naming the same card are one machine
// whatever either has said about itself — which is the whole of what an environment that has never connected says.
const cardKey = (device: Device): string | undefined => (device.hostId === undefined ? undefined : hostEntryOf(device.hostId));

// What makes two devices one computer: a shared card, or a shared hostname where a distro answers to it, since WSL
// hands a distro the Windows machine's name. Two native installs that merely share a name stay two machines.
const tokensOf = (device: Device, distroNames: ReadonlySet<string>): string[] => {
    const card = cardKey(device);
    const hostname = hostnameKey(device);
    return [
        ...(card === undefined ? [] : [`card:${card.toLowerCase()}`]),
        ...(hostname !== undefined && distroNames.has(hostname) ? [`host:${hostname}`] : []),
    ];
};

// Components over both joins at once: a device holding a card token and a hostname token is the evidence that merges
// the machines those tokens named, so a distro connected under a card of its own still lands on the PC it runs on.
interface Component {
    readonly tokens: Set<string>;
    readonly devices: Device[];
}

const componentsOf = (devices: readonly Device[]): Component[] => {
    const distroNames = new Set(devices.filter(isWslDevice).map(hostnameKey).filter((name) => name !== undefined));
    const components: Component[] = [];
    for (const device of devices) {
        const tokens = tokensOf(device, distroNames);
        const [head, ...merged] = components.filter((component) => tokens.some((token) => component.tokens.has(token)));
        if (head === undefined) {
            components.push({ tokens: new Set(tokens), devices: [device] });
            continue;
        }
        for (const other of merged) {
            other.tokens.forEach((token) => head.tokens.add(token));
            head.devices.push(...other.devices);
            components.splice(components.indexOf(other), 1);
        }
        for (const token of tokens) {
            head.tokens.add(token);
        }
        head.devices.push(device);
    }
    return components;
};

// Addressed by the card of the side that owns the screen, an address that does not change when a second environment
// connects — unlike a row key, which is a hostname another environment can take first. An uncarded fold has only the
// hostname its doors share, and an uncarded lone device its own key. Called what the owner calls it: the name the
// leading environment carries, unless that is nothing but its door id, which reads as a PC named after one of its
// own sides.
const machineOf = (environments: readonly Device[]): Machine => {
    const [first, ...rest] = environments;
    // A component holds the device that made it; the empty case only keeps the type honest.
    if (first === undefined) {
        return { key: "", label: "", environments };
    }
    const named = environments.map(cardKey).find((key) => key !== undefined) ?? (rest.length === 0 ? undefined : deviceHostname(first));
    const label = first.label === first.hostId ? (cardKey(first) ?? first.label) : first.label;
    return { key: named ?? first.key, label, environments };
};

export const machinesOf = (devices: readonly Device[]): Machine[] =>
    componentsOf(devices).map((component) => machineOf(component.devices.toSorted(byEnvironment)));

// Every door whose docker reports a given sandbox slug, in list order. More than one is the ordinary case, not a
// conflict: Windows and the WSL distros on it share one engine, so each door answers for the same containers.
const doorsRunningSandbox = (devices: readonly Device[], slug: string | undefined): Device[] =>
    slug === undefined || slug === ""
        ? []
        : devices.filter((device) => device.hostId !== undefined && device.online === true && (device.sandboxes ?? []).some((box) => box.slug === slug));

// The connected, online device whose docker reports a given sandbox slug: the machine that sandbox RUNS ON, as opposed
// to any machine merely paired with it. Answers the question every "run it there instead of asking the owner to type
// it" path starts from, and is `undefined` for a sync-only agent, which reports no containers at all.
// Reads the row's own container list, not the report's: a card that grants sandbox management without "Run commands"
// can run every swap this answer leads to while refusing to describe itself, and judging it on the report would print
// a terminal command for a machine one click could have done it on.
// Answers with a door, and a container verb may take any door of the machine; a command written for a PATH may not
// (`hostHoldingPath`).
export const hostRunningSandbox = (devices: readonly Device[], slug: string | undefined): string | undefined =>
    doorsRunningSandbox(devices, slug)[0]?.hostId;

// A drive letter or a UNC share is a Windows path, everything else a unix one. Not a claim about where the folder is
// on disk: a path only exists in the dialect of the shell that wrote it, and a distro's checkout has no Windows name
// the line naming it would work under.
const windowsPath = (path: string): boolean => /^([A-Za-z]:[\\/]|\\\\)/.test(path);

// Docker Desktop's own distros. `wsl -l -q` lists them like any other and neither ever holds a checkout, so counting
// them would make every Docker Desktop PC look ambiguous.
const SYSTEM_DISTROS: ReadonlySet<string> = new Set(["docker-desktop", "docker-desktop-data"]);

// How a line written for a host path reaches the environment that holds it, through one door. `none` carries the
// distros that were candidates, since "this PC has two and nothing says which" is a different answer for the reader
// than "there is no way in".
export type PathReach =
    | { readonly kind: "direct" }
    | { readonly kind: "wsl"; readonly distro: string }
    | { readonly kind: "none"; readonly distros: readonly string[] };

// How this door runs a line written for this path. A door whose own shell speaks the path's dialect runs it directly;
// a Windows door onto the PC whose distro holds it CROSSES, because `run_command` takes the crossing as an argument
// (`in: "wsl:<distro>"`) and builds the argv on the machine. One connected machine is therefore enough, whichever side
// of it the owner connected.
// `wslDistros` is the gate on purpose: it and `in` shipped in the same agent release, so a machine that lists its
// distros is a machine that understands the crossing, and an older one is left to the refusal instead of being sent
// an argument it would reject. Two real distros stay a refusal that names them — nothing here knows which one has the
// folder, and the distro's own door, once connected, answers directly.
// A platform that never said what it is stays a candidate, as every other reading of device evidence does.
export const pathReach = (platform: string | undefined, facts: DeviceFacts | undefined, path: string): PathReach => {
    if (platform === undefined || (platform === "windows") === windowsPath(path)) {
        return { kind: "direct" };
    }
    const distros = platform === "windows" ? (facts?.wslDistros ?? []).filter((distro) => !SYSTEM_DISTROS.has(distro)) : [];
    const only = distros.length === 1 ? distros[0] : undefined;
    return only === undefined ? { kind: "none", distros } : { kind: "wsl", distro: only };
};

// A path under a door's own home belongs to that door: the one thing that tells two distros of one PC apart, since
// both run sh and both answer for the same containers.
const homeHolds = (device: Device, path: string): boolean => {
    const home = device.facts?.home;
    return home !== undefined && (path === home || path.startsWith(`${home}/`) || path.startsWith(`${home}\\`));
};

// The door for a command written for a path out there — a `cd` into the dev checkout, a script inside it, the log
// beside it. One PC answers through several doors, so "which device runs this sandbox" has more than one true answer
// and only the path says which environment can open it: a sh line aimed at /home/… is a parse error on the Windows
// side of the very machine the build runs on.
// A door that runs the line itself wins over one that has to cross — the same PC, one hop fewer, and no distro to
// guess at — and among direct doors, the one whose own home holds the path, which is what tells two distros apart.
// Undefined only when no connected door reaches that environment at all, which is the state the copyable command
// exists for.
export const hostHoldingPath = (devices: readonly Device[], slug: string | undefined, path: string | undefined): string | undefined => {
    if (path === undefined || path === "") {
        return undefined;
    }
    const doors = doorsRunningSandbox(devices, slug).map((device) => ({ device, reach: pathReach(device.platform, device.facts, path) }));
    const direct = doors.filter((door) => door.reach.kind === "direct").map((door) => door.device);
    const crossing = doors.find((door) => door.reach.kind === "wsl")?.device;
    return (direct.find((device) => homeHolds(device, path)) ?? direct[0] ?? crossing)?.hostId;
};
// GET /system/sync: sandbox-level facts only, whether sync is possible, whether anything is enrolled, and raw device
// reports. Cheap: the sidebar badge reads this and must never fan out to a device.
export const SyncStatusSchema = z.object({
    enrolled: z.boolean(),
    // Whether any machine holds this sandbox's FILES, as opposed to only mirroring its ports — the difference
    // between "a copy of this work exists elsewhere" and "it does not". Absent means the daemon cannot say, which
    // readers must take as "do not claim there is no copy", the same way `available` is read.
    syncing: z.boolean().optional(),
    // Whether this sandbox can do desktop sync at all; absent means a daemon too old to say, so don't offer it.
    available: z.boolean().optional(),
    machines: z.array(DeviceReportSchema).optional(),
});
export type SyncStatus = z.infer<typeof SyncStatusSchema>;
