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
export const HostFactsSchema = z.object({
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
});
export type HostFacts = z.infer<typeof HostFactsSchema>;

// One folder, two names. Windows sees a distro's files under a UNC share and a distro sees the Windows drives under
// /mnt, so a path handed across the boundary is translated here rather than by hand at every call site.
export const wslPathOf = (windowsPath: string): string | undefined => {
    const drive = /^([A-Za-z]):[\\/](.*)$/.exec(windowsPath);
    return drive === null ? undefined : `/mnt/${drive[1]?.toLowerCase()}/${(drive[2] ?? "").replaceAll("\\", "/")}`.replace(/\/$/, "");
};
export const windowsPathOf = (distro: string, linuxPath: string): string => `\\\\wsl.localhost\\${distro}${linuxPath.replaceAll("/", "\\")}`;
export const HostSummarySchema = z.object({
    // The capability id, the machine's name, and the prefix of its tools (mcp__<id>__run_command).
    id: z.string(),
    platform: z.string().min(1),
    online: z.boolean(),
    // Agent binary version; absent until the machine has connected once.
    version: z.string().optional(),
    // Epoch ms of the last held socket; absent means not since this daemon booted (liveness resets on restart).
    lastSeen: z.number().optional(),
    facts: HostFactsSchema.optional(),
});
export type HostSummary = z.infer<typeof HostSummarySchema>;
export const HostsListSchema = z.object({ hosts: z.array(HostSummarySchema) });
