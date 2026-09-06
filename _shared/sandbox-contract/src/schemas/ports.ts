// ports: every listening TCP socket in the sandbox + explicit port forwarding
import { z } from "zod";
// Anything run in a terminal (a turbo TUI fanning out dev servers, `python -m http.server`, an agent's ad-hoc
// process) binds ports the daemon never assigned, the panel machinery can't see them. The /ports routes are
// the generic complement: `list` reports the live listeners (procfs scan, on demand), `forward` makes one
// reachable at port-<slot>-<sandboxId>.<zone> through the preview proxy. Forwarding is an explicit gesture,
// previews are public, so nothing is exposed until the owner (or an agent acting for them) asks.

export const PortSummarySchema = z.object({
    port: z.number().describe("The port number."),
    // The loopback address the listener actually answers at inside the sandbox, a `localhost` bind can land
    // on ::1 only (Vite). The preview proxy and the desktop mirror (Mutagen forward) both dial this.
    host: z
        .enum(["127.0.0.1", "::1"])
        .describe("Which loopback address it actually answers on. Some tools bind only one of the two, and anything dialling it has to know which."),
    // Whether the proxy can actually reach the listener at `host`. False for a bind to a loopback alias like
    // Docker's embedded DNS (127.0.0.11), which answers only at its own address, not 127.0.0.1, such rows are
    // listed for transparency but the Ports view hides Preview and forwarding them is refused.
    forwardable: z
        .boolean()
        .describe(
            "Whether it can be exposed at all. Some listeners answer only at their own address and nowhere else; those are listed for honesty and refused for forwarding.",
        ),
    // Which bucket the Ports view files it under: `workspace` = user-run (dev servers in repos, terminal
    // processes, published container ports), the previewable set; `system` = the sandbox's own machinery
    // (agent runtimes, translator, dockerd, sshd), listed for transparency but nobody previews it.
    kind: z
        .enum(["workspace", "system"])
        .describe("Whether somebody's own work put it there, or the sandbox's own machinery did. Only the first kind is worth previewing."),
    /* WHAT IS ON THIS PORT, IN WORDS: resolved by the daemon (ports/port-identity.ts), because the two facts
     * that attribute a listener (the panel key → extension index, the workspace root) exist there and nowhere
     * else. `title` is what a person would call it ("Vite dev server", "Sandbox service", "Container port"),
     * `purpose` is the one sentence a row shows under it, and `origin` says who put it there, which is what
     * the reader is really asking when they ask what a port is: mine, my agent's, or the box's own.
     *
     * All three are required. A listener nothing can explain still gets a name ("Unclaimed port") and a
     * sentence that says so out loud, because the alternative (a raw argv, or nothing) is what made this
     * view unreadable, and the button beside the row publishes the port to the internet. */
    title: z
        .string()
        .describe(
            "What a person would call it. Always present: a listener nothing can explain is still named, because the button beside it publishes the port to the internet.",
        ),
    purpose: z.string().describe("One sentence about what it is for, including when the honest answer is that nothing could work it out."),
    origin: z
        .enum(["terminal", "agent", "panel", "extension", "container", "sandbox", "unknown"])
        .describe("Who put it there, which is the question somebody is really asking: mine, my agent's, or the box's own."),
    // The owning process, resolved from procfs; absent when no /proc/*/fd entry matched the socket's inode.
    pid: z.number().optional().describe("The process holding it. Absent when nothing could be matched to the socket."),
    // How the row is labeled: the process argv joined with spaces ("node /work/app/node_modules/.bin/vite"),
    // falling back to the kernel `comm` name when argv is empty, or a synthesized name for attributable
    // infrastructure the pid walk can't reach ("Docker embedded DNS"). Absent only when wholly unattributable.
    command: z.string().optional().describe("The command behind it, as it was run. Absent only when nothing could be attributed at all."),
    // The process working directory (how the UI attributes a port to a repo).
    cwd: z.string().optional().describe("Where it is running from, which is how a port gets attributed to a repository."),
    // The tmux session the listener descends from, the terminal to watch it in or stop it from. Absent when
    // nothing in its ancestry is a pane (a daemon-managed runtime, a published container's docker-proxy), which
    // is the honest "you cannot reach this from here" rather than a terminal that would open onto nothing.
    session: z
        .string()
        .optional()
        .describe(
            'The terminal it came from, to watch it in or stop it from. Absent when nothing in its ancestry is one, which is the honest "you cannot reach this from here".',
        ),
    forwarded: z.boolean().describe("Whether it is currently reachable from outside."),
    // https://port-<slot>-<sandboxId>.<zone>; present only while forwarded AND the sandbox has a zone + id.
    previewUrl: z.string().optional().describe("Where to open it. Present only while forwarded, and only on a sandbox that has an outside address."),
});
export type PortSummary = z.infer<typeof PortSummarySchema>;
export const PortsListSchema = z.object({
    ports: z
        .array(PortSummarySchema)
        .describe("Everything listening inside the sandbox right now, read fresh each time rather than from a register the sandbox keeps."),
});
export type PortsList = z.infer<typeof PortsListSchema>;
export const PortParamSchema = z.object({ port: z.number().int().min(1).max(65535).describe("Which port.") });
// `previewUrl` is absent on a loopback/no-tunnel sandbox, the slot is mapped, but no public hostname exists.
export const PortForwardResultSchema = z.object({
    previewUrl: z
        .string()
        .optional()
        .describe("Where it can now be reached. Absent on a sandbox with no outside address, where the mapping exists but has no public name."),
});
export type PortForwardResult = z.infer<typeof PortForwardResultSchema>;
