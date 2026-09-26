// hosts: the user's own connected devices (the `host` capability's live half)
import { z } from "zod";
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
});
export type DeviceFacts = z.infer<typeof DeviceFactsSchema>;

// The optional device ops, by what enables them:
// - `reshape-later`: the old `reshape` op with `later`, saving the change for the next restart. An agent from before it
//   strips `later` and reshapes NOW, which is why a later-reshape is never sent to one.
// - `set-shape`: the `set-shape`/`forget-shape` ops, and `start`/`restart` applying a saved shape, all through an `ic`
//   whose `ic sandbox shape` takes the contract's own shape (`--set`); advertised only when the agent's `ic` does.
//   Both features ride that verb, so an agent advertises both or neither.
export const DeviceFeatureSchema = z.enum(["reshape-later", "set-shape"]);
export type DeviceFeature = z.infer<typeof DeviceFeatureSchema>;
export const DEVICE_FEATURE_RESHAPE_LATER: DeviceFeature = "reshape-later";
export const DEVICE_FEATURE_SET_SHAPE: DeviceFeature = "set-shape";
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
