// hosts: the user's own connected devices (the `host` capability's live half)
import { z } from "zod";
import { IntenticOsFactsSchema } from "./intentic-os.js";
// Manifest says which machines are intended; this says which actually hold a socket now. Nothing persists across a
// daemon restart except the enrollment itself, so a closed laptop reads offline within a heartbeat.

// Which WSL distro a Linux agent runs inside. Windows and every distro it hosts answer `hostname` with the same string
// while being separate filesystems running separate agents, so this is what keeps a distro apart from the install
// hosting it. `distro` is WSL's own name for it ("Arch", "Ubuntu-22.04"), empty when the distro won't say.
export const WslEnvironmentSchema = z.object({ distro: z.string() });
export type WslEnvironment = z.infer<typeof WslEnvironmentSchema>;

// WHICH PHYSICAL COMPUTER A DOOR IS ON. The machine agent mints this once, at install, and keeps it in its own state
// (`~/.intentic/machine/machine-id`); a WSL distro's agent is handed its Windows side's, since a distro is an
// environment of the PC, not a second computer. It is what an enrollment, a sync enrollment and a device row are
// joined on — never a hostname, which WSL shares between a PC and its distros and a user can rename.
export const MachineIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/);
// An id the daemon stands in for a machine that has not said its own yet (an enrollment made before agents reported
// one): named after the card, so every environment of that card shares it until each reports the real id. Never
// sent by an agent, and never the join key of two different cards.
export const derivedMachineId = (card: string): string => `card:${card}`;
export const isDerivedMachineId = (machineId: string): boolean => machineId.startsWith("card:");

// Which computer and which OS install on it is enrolling (`environmentKeyOf`), as the machine agent says it when it
// redeems a pairing. Both optional, since an agent older than either says nothing.
export const MachineIdentitySchema = z.object({
    machineId: MachineIdSchema.optional(),
    environment: z.string().min(1).optional(),
});
export type MachineIdentity = z.infer<typeof MachineIdentitySchema>;

// (2026-10-20) The body of POST /system/hosts/enroll: the redeeming agent's identity, so the enrollment is written with
// its real machine id instead of the card's derived one and joins that machine's sync row from its first write. Before
// this the route took no body and the id was learned only at the agent's first connect, which left a freshly paired
// computer as two machine cards until then. An agent older than it sends none, and the daemon reads one it cannot parse
// as none. Kept here rather than beside the answer (peer-enrollment.ts), which the browser extension bundles.
export const PeerEnrollmentRequestSchema = MachineIdentitySchema;
export type PeerEnrollmentRequest = MachineIdentity;

// How many skipped lines an agent sends in its upkeep summary at most; the counts cover the rest.
export const UPKEEP_SKIPPED_SHOWN = 10;

// What the machine agent's own upkeep found in this environment at its last pass (its device reconciler, run at start
// and every six hours): how many leftovers of each kind it found and how many it put right, and the first
// UPKEEP_SKIPPED_SHOWN of those it left, each with why. Kinds are the agent's words (`retired-files`, `trash`,
// `login-entry`…), read as strings, so a kind a newer agent adds is one more key rather than a facts row that fails to
// parse; for the same reason the cap on `skipped` is the sender's, not checked here. `at` is epoch ms.
export const DeviceUpkeepSchema = z.object({
    at: z.number(),
    found: z.record(z.string(), z.number()),
    fixed: z.record(z.string(), z.number()),
    skipped: z.array(z.object({ kind: z.string(), what: z.string(), why: z.string() })),
});
export type DeviceUpkeep = z.infer<typeof DeviceUpkeepSchema>;

// What a machine reports once at connect (`host.describe`), cached until it reconnects: the skill pack says how to
// drive Windows, this says which Windows it is.
export const DeviceFactsSchema = z.object({
    // The computer this environment is on (MachineIdSchema). Absent from an agent older than the field.
    machineId: MachineIdSchema.optional(),
    // The OS's own name for itself, e.g. "Windows 11 Pro 24H2".
    os: z.string(),
    arch: z.string(),
    // The shell run_command actually spawns, so the agent writes for the right one from its first command.
    shell: z.string(),
    // The machine's home directory, and the default root when the capability declares none.
    home: z.string(),
    // Roots in force right now (the capability's `roots`, or [home]), the agent sees its own boundary.
    roots: z.array(z.string()),
    // Docker engine's size (WSL guest on Windows, Desktop VM on macOS, host on Linux); the ceiling a sandbox's share is
    // bounded by.
    engine: z.object({ memoryBytes: z.number(), cpus: z.number() }).optional(),
    // OS hostname, for the owner to read. Not a join key: `machineId` is.
    hostname: z.string().optional(),
    // Present only inside a WSL distro.
    wsl: WslEnvironmentSchema.optional(),
    // Windows only: the distros `wsl -l -q` lists, the names `run_command`'s `in: "wsl:<name>"` accepts.
    wslDistros: z.array(z.string()).optional(),
    // What this machine's agent is holding links to, and how much of it is answering nothing. COUNTS AND AN AGE ONLY:
    // the rest are other sandboxes' addresses, and a sandbox has no business learning its siblings'. Absent from an
    // agent older than this field, which is why "none unreachable" is not the same value as "did not say".
    links: z.object({ total: z.number(), unreachable: z.number(), unreachableSince: z.number().optional() }).optional(),
    // Which of the optional ops this agent AND the `ic` it drives implement (DeviceFeatureSchema), for a page to offer
    // only what works and for the daemon to refuse an op before sending it. Strings on the wire, so a newer agent's
    // feature never fails an older daemon's read; `deviceFeatures` keeps the ones this build knows. Nothing is
    // detected by a field's presence any more: the device RPC inputs are strict, and an agent rejects a field it does
    // not know rather than dropping it.
    features: z.array(z.string()).optional(),
    // Why the `ic` this agent drives is older than the agent, as one sentence, when fetching the current one failed:
    // what explains `features` missing what this agent's release has (a stale ic has no logs verb and no `--set`).
    // Absent when ic is current, and from an agent older than the field.
    icOutOfDate: z.string().optional(),
    // The agent's last upkeep pass in this environment (DeviceUpkeepSchema): whether a release brought this machine to
    // the current shape, read rather than assumed. Absent before the first pass, and from an agent older than the field.
    upkeep: DeviceUpkeepSchema.optional(),
    // How the agent before this one ended, as one sentence (watchdog kill, crash, update, reboot), so a device that
    // dropped off says why once it is back. Absent on a first start, and from an agent older than the field.
    previousExit: z.string().optional(),
    // Which ic answers on this machine and what steers it: an old ic.exe installed from a leftover IC_URL looked like
    // a daemon bug for an afternoon. Override values are the agent's own redaction (secret-looking ones by length).
    ic: z.object({ path: z.string(), version: z.string(), modified: z.string().optional() }).optional(),
    icOverrides: z.array(z.string()).optional(),
    // (2026-10-13) Present only on Intentic OS (`/usr/lib/intentic-os/release.json`): which edition, version and channel
    // the machine boots, so the daemon tells the agent it may be this box's steward and the os_* tools are there. `os`
    // above stays the human name. Absent everywhere else, and from an agent older than the field.
    intenticOs: IntenticOsFactsSchema.optional(),
});
export type DeviceFacts = z.infer<typeof DeviceFactsSchema>;

// The optional device ops, by what enables them:
// - `reshape-later`: the old `reshape` op with `later`, saving the change for the next restart. An agent from before it
//   strips `later` and reshapes NOW, which is why a later-reshape is never sent to one. Redundant with `set-shape`'s
//   `when` for every current page; kept only for pages and daemons from before `set-shape` (v1.312.0 and older),
//   which check it. REMOVE IN v1.314.0, with the old `reshape` op it gates.
// - `set-shape`: the `set-shape`/`forget-shape` ops, and `start`/`restart` applying a saved shape, all through an `ic`
//   whose `ic sandbox shape` takes the contract's own shape (`--set`); advertised only when the agent's `ic` does.
//   Both features ride that verb, so an agent advertises both or neither.
// - `rollback-to`: the `rollback` op's `to`, going back to an older version kept on the machine rather than the
//   previous one; advertised only when the agent's `ic sandbox rollback` takes `--to`.
// - `loopback-catch`: the `catchLoopback` procedure, a sign-in's loopback redirect caught on this machine
//   (loopback-catch.ts); an agent without it rejects the call as an unknown procedure.
// - `background-prepare`: the `prepare-background` op, the next update downloaded under the unattended rules of the
//   agent's own timer (`ic sandbox prepare --auto`), which the update card sends when it opens; advertised only when
//   the agent's `ic sandbox prepare` takes `--auto`.
// - `programs`: the `stageArtifact` procedure and the app_* tools, a program this sandbox built pushed to the machine and
//   run under the agent's supervision (device-artifacts.ts); an agent without it is told to update rather than sent one.
// - `project-delivery`: the `deliverProject` procedure, landed work written into a folder attached to this computer's
//   sandbox (project-delivery.ts); an agent without it is never sent one, and the land waits for Bring back.
// - `keyring`: the keyring* procedures, intentic-keyring on this computer reached through the machine (keyring.ts);
//   advertised only while a keyring is installed, so a sandbox never offers a computer without one as a place to keep or
//   type a secret.
// - `sleep`: the `sleep` op, a sandbox put to sleep now (`ic sandbox sleep <slug>`): stopped, and started again by
//   itself when somebody opens it; advertised only when the agent's `ic` has `sandbox sleep`.
// - `reachable-ways-back`: not an op but what a listing means: a sandbox's `rollbackTargets` are only the ways back a
//   rollback can reach (ic 2026-10-19 on). Said by ic itself (`ic features`, golden/ic-features.json); without it the
//   rows are an older ic's, which also listed pruned dev builds no download can bring back (state/ways-back.ts).
export const DeviceFeatureSchema = z.enum([
    "reshape-later",
    "set-shape",
    "rollback-to",
    "loopback-catch",
    "background-prepare",
    "project-delivery",
    "programs",
    "keyring",
    "sleep",
    "reachable-ways-back",
]);
export type DeviceFeature = z.infer<typeof DeviceFeatureSchema>;
export const DEVICE_FEATURE_RESHAPE_LATER: DeviceFeature = "reshape-later";
export const DEVICE_FEATURE_SET_SHAPE: DeviceFeature = "set-shape";
export const DEVICE_FEATURE_ROLLBACK_TO: DeviceFeature = "rollback-to";
export const DEVICE_FEATURE_LOOPBACK_CATCH: DeviceFeature = "loopback-catch";
export const DEVICE_FEATURE_BACKGROUND_PREPARE: DeviceFeature = "background-prepare";
export const DEVICE_FEATURE_PROJECT_DELIVERY: DeviceFeature = "project-delivery";
export const DEVICE_FEATURE_PROGRAMS: DeviceFeature = "programs";
export const DEVICE_FEATURE_KEYRING: DeviceFeature = "keyring";
export const DEVICE_FEATURE_SLEEP: DeviceFeature = "sleep";
export const DEVICE_FEATURE_REACHABLE_WAYS_BACK: DeviceFeature = "reachable-ways-back";
// What `ic features --json` answers (_sandbox/ic/src/features.rs, golden/ic-features.json): the optional ops that ic
// implements, as strings, since a newer ic's word means nothing to an older agent.
export const IcFeaturesAnswerSchema = z.object({ features: z.array(z.string()) });

// The features an agent advertised that this build knows; an unknown one is a newer agent's and means nothing here.
export const deviceFeatures = (facts: Pick<DeviceFacts, "features"> | undefined): DeviceFeature[] =>
    (facts?.features ?? []).flatMap((feature) => {
        const known = DeviceFeatureSchema.safeParse(feature);
        return known.success ? [known.data] : [];
    });
export const deviceSupports = (facts: Pick<DeviceFacts, "features"> | undefined, feature: DeviceFeature): boolean => deviceFeatures(facts).includes(feature);

// Docker Desktop's own distros: `wsl -l -q` lists them like any other, and none ever runs an agent or holds a checkout.
export const WSL_SYSTEM_DISTROS: ReadonlySet<string> = new Set(["docker-desktop", "docker-desktop-data"]);

// The distros a Windows side lists that are the user's own: the only ones any screen offers, crosses into or boots.
export const userDistrosOf = (facts: Pick<DeviceFacts, "wslDistros"> | undefined): string[] =>
    (facts?.wslDistros ?? []).filter((distro) => !WSL_SYSTEM_DISTROS.has(distro));

// One folder, two names. Windows sees a distro's files under a UNC share and a distro sees the Windows drives under
// /mnt, so a path handed across the boundary is translated here rather than by hand at every call site.
export const wslPathOf = (windowsPath: string): string | undefined => {
    const drive = /^([A-Za-z]):[\\/](.*)$/.exec(windowsPath);
    return drive === null ? undefined : `/mnt/${drive[1]?.toLowerCase()}/${(drive[2] ?? "").replaceAll("\\", "/")}`.replace(/\/$/, "");
};
export const windowsPathOf = (distro: string, linuxPath: string): string => `\\\\wsl.localhost\\${distro}${linuxPath.replaceAll("/", "\\")}`;

// ONE CARD IS ONE COMPUTER, AND EACH OS INSTALL ON IT IS A CONNECTION OF THAT CARD. A PC's Windows side and every WSL
// distro on it hold their own agent — mutagen has to watch the filesystem it syncs, and a distro's login shell is its
// own — but the owner connected a computer, not a shell, so the grant, the row and the tools are the machine's.
export const HOST_NATIVE_ENVIRONMENT = "native";

// Which environment a machine is describing when it connects: the distro by the name WSL registered (what `wsl -l -q`
// prints and `in: "wsl:<name>"` takes), or the metal. Facts arrive at connect and no scope withholds them, so this is
// always answerable — unlike `environmentOf` (devices.ts), which weighs a report too and may hold no evidence at all.
export const environmentKeyOf = (facts: Pick<DeviceFacts, "wsl">): string =>
    facts.wsl === undefined ? HOST_NATIVE_ENVIRONMENT : `wsl:${facts.wsl.distro}`;

// A CONNECTION'S KEY, spelled and read in exactly one place. The key is what the hub, a device RPC and a page's row
// address a connection by: the native environment's key IS the card id, and a sibling hangs off it as
// `<card>::wsl:<distro>` (`::` cannot collide with the single colon in an environment key). What a connection IS —
// its card, its environment, its computer — is the enrollment's own record (a host enrollment says all three, and a
// device row carries `card`), so the parser is only for a key with nothing beside it: the key the owner asks to pair,
// an enrollment written before records said, a row from a daemon older than `card`. A rename relabels the record and
// the key follows from the label; the live connection is held under the new key without being cut (PeerHub.rekey).
export interface HostConnection {
    readonly card: string;
    readonly environment: string;
}
const ENVIRONMENT_SEPARATOR = "::";

export const hostConnectionKey = (card: string, environment: string): string =>
    environment === HOST_NATIVE_ENVIRONMENT ? card : `${card}${ENVIRONMENT_SEPARATOR}${environment}`;

export const parseHostConnection = (key: string): HostConnection => {
    const at = key.indexOf(ENVIRONMENT_SEPARATOR);
    return at === -1
        ? { card: key, environment: HOST_NATIVE_ENVIRONMENT }
        : { card: key.slice(0, at), environment: key.slice(at + ENVIRONMENT_SEPARATOR.length) };
};

// One OS install of a machine, as its card knows it. `key` is the environment (`native`, `wsl:archlinux`); everything
// else is what its own agent reported through its own socket, so two environments of one PC never share liveness or a
// version — one side can be asleep, or running a build behind.
export const HostEnvironmentSchema = z.object({
    key: z.string().min(1),
    // The computer this environment's enrollment is on, once its agent has said (never a derived id): what joins it to
    // a sync enrollment and to the other environments of that computer, whether or not it is connected right now.
    machineId: MachineIdSchema.optional(),
    online: z.boolean(),
    version: z.string().optional(),
    lastSeen: z.number().optional(),
    facts: DeviceFactsSchema.optional(),
});
export type HostEnvironment = z.infer<typeof HostEnvironmentSchema>;

// HOW MUCH OF ONE COMPUTER ANSWERS RIGHT NOW (2026-10-20), read off its environments' own sockets: the one answer
// /capabilities, the Devices board and a call's routing give about a machine. `online` while its native side answers
// (the one named after the card, which owns the screen and every tool but `run_command`'s crossing), whatever its
// distros do, since a distro asleep beside a live Windows is the ordinary state of a PC; `partly` while the native side
// does not and another environment does (a call naming that side still reaches it); `offline` while nothing does. Before
// this the card read the native side alone and the board any side, so one PC was offline on one screen and live on the
// next (2026-10-13), and "partly" was worked out twice more. A list with no native side at all (a machine seen only
// through a distro's sync) is online while anything of it answers.
export type MachinePresence =
    | { readonly kind: "online" }
    | { readonly kind: "partly"; readonly awake: readonly string[] }
    | { readonly kind: "offline" };

export const machinePresence = (environments: readonly Pick<HostEnvironment, "key" | "online">[]): MachinePresence => {
    const native = environments.find((environment) => environment.key === HOST_NATIVE_ENVIRONMENT);
    const awake = environments
        .filter((environment) => environment.key !== HOST_NATIVE_ENVIRONMENT && environment.online)
        .map((environment) => environment.key)
        .toSorted();
    if (native?.online === true || (native === undefined && awake.length > 0)) {
        return { kind: "online" };
    }
    return awake.length > 0 ? { kind: "partly", awake } : { kind: "offline" };
};

// An environment by the name a person and `run_command`'s `in` know it by: a distro by its WSL name, the rest by key.
export const environmentName = (key: string): string => (key.startsWith("wsl:") ? key.slice("wsl:".length) : key);

export const HostSummarySchema = z.object({
    // The capability id, the machine's name, and the prefix of its tools (mcp__<id>__run_command). On a per-connection
    // row (`hostConnections`) it is that connection's key instead, and `card` names the machine.
    id: z.string(),
    // The card a per-connection row is a connection of: a label on the row, read rather than parsed out of `id`.
    card: z.string().optional(),
    platform: z.string().min(1),
    // Every environment of this machine, native first: what the page draws a row per, and what a command picks from.
    // Never empty — a card that has never connected still has its native environment, offline.
    environments: z.array(HostEnvironmentSchema).min(1),
    // The native environment's own state, restated because every existing reader asks the machine, not a side of it.
    online: z.boolean(),
    // Agent binary version; absent until the machine has connected once.
    version: z.string().optional(),
    // Epoch ms of the last held socket; absent means not since this daemon booted (liveness resets on restart).
    lastSeen: z.number().optional(),
    facts: DeviceFactsSchema.optional(),
});
export type HostSummary = z.infer<typeof HostSummarySchema>;
export const HostsListSchema = z.object({ hosts: z.array(HostSummarySchema) });
