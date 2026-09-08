// What one of the user's own machines is running.
import { z } from "zod";
import { HostFactsSchema } from "./hosts.js";
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
    // Only op that redeems a fresh setup code; others recreate a container from its own existing env.
    "reconnect",
    "runner-up",
    "runner-remove",
]);
export type DeviceSandboxOp = z.infer<typeof DeviceSandboxOpSchema>;
export const DeviceSandboxFlowSchema = z.object({
    op: DeviceSandboxOpSchema,
    // Sandbox slug, or the runner's name for the runner ops (as `/system/runners`/`ic runner list` know it).
    slug: z.string().min(1),
    // Approved overlay's sha256, required only by `rebuild`; only content matching it is ever built.
    hash: z.string().optional(),
    // What `reshape` should change, required by it and meaningless to the rest.
    resources: SandboxResourcesAskSchema.optional(),
    // `runner-up` only, daemon-filled, never by the caller: the browser never holds the pairing credential.
    parentUrl: z.string().optional(),
    pair: z.string().optional().meta({ secret: true }),
    // Required by `reconnect` only; single-sandbox and short-lived, so a leak only buys a recreate.
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
// Both ops stop the resident process mid-command; a stream ending with no terminal frame is normal, not a failure, and
// confirmation is the version moving on the next poll. `restart` is just a bare `intentic-machine run`.
export const DeviceAgentOpSchema = z.enum(["upgrade", "restart"]);
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
export const DeviceCommandSchema = z.enum(["mirror-off", "mirror-on", "sync-pause", "sync-resume", "sync-unpair"]);
export type DeviceCommand = z.infer<typeof DeviceCommandSchema>;
// Machine's sandbox id (absent = every paired sandbox); must start alphanumeric, else it parses as a CLI flag.
export const DeviceSandboxIdSchema = z
    .string()
    .max(200)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
export const DeviceCommandInputSchema = z.object({
    id: z.string().min(1),
    command: DeviceCommandSchema,
    sandboxId: DeviceSandboxIdSchema.optional(),
});
export type DeviceCommandInput = z.infer<typeof DeviceCommandInputSchema>;
// `ok` is the command's own exit status, not this route's: a refusal or non-zero exit is a real answer, not a thrown
// error. Only an unreachable machine throws. `output` is the command's own printed text.
export const DeviceCommandResultSchema = z.object({
    ok: z.boolean(),
    message: z.string(),
    output: z.string().optional(),
});
export type DeviceCommandResult = z.infer<typeof DeviceCommandResultSchema>;

// Mutagen's three change kinds, read per side of a conflict; a count alone named no file, cause or remedy. Absent means
// Mutagen did not say, not that a side is untouched.
export const DeviceConflictChangeSchema = z.enum(["created", "modified", "deleted"]);
export type DeviceConflictChange = z.infer<typeof DeviceConflictChangeSchema>;

export const DeviceConflictSchema = z.object({
    /** Relative to the synced folder (matches both `localDir` and /work); empty means the root itself. */
    path: z.string(),
    /** What happened on the device (Mutagen's alpha). */
    local: DeviceConflictChangeSchema.optional(),
    /** And in the sandbox's /work (its beta). */
    sandbox: DeviceConflictChangeSchema.optional(),
});
export type DeviceConflict = z.infer<typeof DeviceConflictSchema>;

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
]);
export const DevicePortSchema = z.object({
    port: z.number().int().min(1).max(65535),
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
    // OS hostname; the join key that dedupes a machine seen via sync and via its `host` capability.
    hostname: z.string(),
    os: z.string(),
    // Filled by the reader, never the agent; empty means no Docker or nothing looked, not that none exist.
    sandboxes: z.array(DeviceSandboxSchema),
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
    // Connected, but "Run commands" is off on its capability card; the daemon may not ask it anything.
    "scope-off",
    // Reachable and asked, but has no `intentic-machine` installed, so nothing knows its folders or ports.
    "no-agent",
    // Sync-enrolled but has not posted a report yet; unlike `no-agent`, the agent is there and syncing.
    "unreported",
]);
export type DeviceGap = z.infer<typeof DeviceGapSchema>;
// A machine may be reachable via desktop sync and a host capability at once; the two are reconciled on `hostname`, and
// left as separate rows when there is nothing to reconcile them by.
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
    facts: HostFactsSchema.optional(),
    // Announced at connect; matches `report.agent.build` when known, the only version a report-less device has.
    agentVersion: z.string().optional(),
    lastSeen: z.number().optional(),
    report: DeviceReportSchema.optional(),
    gap: DeviceGapSchema.optional(),
});
export type Device = z.infer<typeof DeviceSchema>;
export const DevicesListSchema = z.object({ devices: z.array(DeviceSchema) });
// GET /system/sync: sandbox-level facts only, whether sync is possible, whether anything is enrolled, and raw device
// reports. Cheap: the sidebar badge reads this and must never fan out to a device.
export const SyncStatusSchema = z.object({
    enrolled: z.boolean(),
    // Whether this sandbox can do desktop sync at all; absent means a daemon too old to say, so don't offer it.
    available: z.boolean().optional(),
    machines: z.array(DeviceReportSchema).optional(),
});
export type SyncStatus = z.infer<typeof SyncStatusSchema>;
