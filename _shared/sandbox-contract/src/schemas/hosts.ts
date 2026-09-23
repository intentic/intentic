// hosts: the user's own connected devices (the `host` capability's live half)
import { z } from "zod";
// Manifest says which machines are intended; this says which actually hold a socket now. Nothing persists across a
// daemon restart except the enrollment itself, so a closed laptop reads offline within a heartbeat.

// Which WSL distro a Linux agent runs inside. Windows and every distro it hosts answer `hostname` with the same string
// while being separate filesystems running separate agents, so this is what keeps a distro apart from the install
// hosting it. `distro` is WSL's own name for it ("Arch", "Ubuntu-22.04"), empty when the distro won't say.
export const WslEnvironmentSchema = z.object({ distro: z.string() });
export type WslEnvironment = z.infer<typeof WslEnvironmentSchema>;

// What a machine reports once at connect (`host.describe`), cached until it reconnects: the skill pack says how to
// drive Windows, this says which Windows it is.
export const DeviceFactsSchema = z.object({
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
    // OS hostname: the key that joins the doors of one physical machine. Reported by every agent that also reports
    // `wsl`, so a hostname with no `wsl` beside it is a native install; absent from an agent older than both.
    hostname: z.string().optional(),
    // Present only inside a WSL distro.
    wsl: WslEnvironmentSchema.optional(),
    // Windows only: the distros `wsl -l -q` lists, the names `run_command`'s `in: "wsl:<name>"` accepts.
    wslDistros: z.array(z.string()).optional(),
    // What this machine's agent is holding links to, and how much of it is answering nothing. COUNTS AND AN AGE ONLY:
    // the rest are other sandboxes' addresses, and a sandbox has no business learning its siblings'. Absent from an
    // agent older than this field, which is why "none unreachable" is not the same value as "did not say".
    links: z.object({ total: z.number(), unreachable: z.number(), unreachableSince: z.number().optional() }).optional(),
});
export type DeviceFacts = z.infer<typeof DeviceFactsSchema>;

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
// The native environment's connection key IS the card id, by definition rather than as a fallback: a machine with one
// OS install has one connection named after itself, and a sibling hangs off it as `<card>::wsl:<distro>`. `::` cannot
// collide with the single colon in an environment key.
export const HOST_NATIVE_ENVIRONMENT = "native";
const ENVIRONMENT_SEPARATOR = "::";

// Which environment a machine is describing when it connects: the distro by the name WSL registered (what `wsl -l -q`
// prints and `in: "wsl:<name>"` takes), or the metal. Facts arrive at connect and no scope withholds them, so this is
// always answerable — unlike `environmentOf` (devices.ts), which weighs a report too and may hold no evidence at all.
export const environmentKeyOf = (facts: Pick<DeviceFacts, "wsl">): string =>
    facts.wsl === undefined ? HOST_NATIVE_ENVIRONMENT : `wsl:${facts.wsl.distro}`;

export const hostConnectionKey = (entry: string, environment: string): string =>
    environment === HOST_NATIVE_ENVIRONMENT ? entry : `${entry}${ENVIRONMENT_SEPARATOR}${environment}`;

export const hostEntryOf = (connection: string): string => connection.split(ENVIRONMENT_SEPARATOR)[0] ?? connection;

export const hostEnvironmentOf = (connection: string): string => {
    const at = connection.indexOf(ENVIRONMENT_SEPARATOR);
    return at === -1 ? HOST_NATIVE_ENVIRONMENT : connection.slice(at + ENVIRONMENT_SEPARATOR.length);
};

// One OS install of a machine, as its card knows it. `key` is the environment (`native`, `wsl:archlinux`); everything
// else is what its own agent reported through its own socket, so two environments of one PC never share liveness or a
// version — one side can be asleep, or running a build behind.
export const HostEnvironmentSchema = z.object({
    key: z.string().min(1),
    online: z.boolean(),
    version: z.string().optional(),
    lastSeen: z.number().optional(),
    facts: DeviceFactsSchema.optional(),
});
export type HostEnvironment = z.infer<typeof HostEnvironmentSchema>;

export const HostSummarySchema = z.object({
    // The capability id, the machine's name, and the prefix of its tools (mcp__<id>__run_command).
    id: z.string(),
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
