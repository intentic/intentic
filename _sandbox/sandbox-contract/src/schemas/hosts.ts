// hosts: the user's own connected devices (the `host` capability's live half)
import { z } from "zod";
// The manifest says which machines the user INTENDS to have connected; this says which are actually holding a
// socket right now. Nothing here is remembered across a daemon restart except the enrollment itself: a machine
// is "online" exactly while its WebSocket is attached, so a laptop that closed its lid reads as offline within
// a heartbeat rather than staying green until someone asks it to do something.

// What a machine reports about itself once, at connect (the agent's own `host.describe`, cached until it
// reconnects). It is the difference between an agent guessing what is on the box and knowing: the SKILL pack
// tells it HOW to drive Windows, this tells it WHICH Windows this is.
export const HostFactsSchema = z.object({
    // The OS's own name for itself, "Windows 11 Pro 24H2", "Ubuntu 24.04.1 LTS".
    os: z.string(),
    arch: z.string(),
    // The shell run_command actually spawns, so the agent writes for the right one from its first command.
    shell: z.string(),
    // The machine's home directory, and the default root when the capability declares none.
    home: z.string(),
    // Roots in force right now (the capability's `roots`, or [home]), the agent sees its own boundary.
    roots: z.array(z.string()),
});
export type HostFacts = z.infer<typeof HostFactsSchema>;
export const HostSummarySchema = z.object({
    // The capability id, the machine's name, and the prefix of its tools (mcp__<id>__run_command).
    id: z.string(),
    platform: z.string().min(1),
    online: z.boolean(),
    // The agent binary's version, so a machine running an old build is visible rather than mysteriously lacking
    // a tool. Absent until the machine has connected once.
    version: z.string().optional(),
    // Epoch ms of the last time this machine held a socket. Absent ⇒ it has not connected since this daemon
    // booted, liveness is a fact about a socket, so a restart forgets it rather than claiming stale uptime.
    lastSeen: z.number().optional(),
    facts: HostFactsSchema.optional(),
});
export type HostSummary = z.infer<typeof HostSummarySchema>;
export const HostsListSchema = z.object({ hosts: z.array(HostSummarySchema) });
