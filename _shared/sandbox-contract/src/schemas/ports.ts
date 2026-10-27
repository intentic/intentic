// ports: every listening TCP socket in the sandbox + explicit port forwarding
import { z } from "zod";
// Terminal-bound ports (a TUI, an ad-hoc process) that the panel machinery can't see; `list` scans procfs live,
// `forward` exposes one at port-<slot>-<sandboxId>.<zone> through the preview proxy. Forwarding is explicit — nothing
// is public until asked for.

export const PortSummarySchema = z.object({
    port: z.number().describe("The port number."),
    // Vite, for one, binds only ::1; the preview proxy and the desktop mirror both dial this address.
    host: z
        .enum(["127.0.0.1", "::1"])
        .describe("Which loopback address it actually answers on. Some tools bind only one of the two, and anything dialling it has to know which."),
    // e.g. Docker's embedded DNS at 127.0.0.11, which only answers at its own address.
    forwardable: z
        .boolean()
        .describe(
            "Whether it can be exposed at all. Some listeners answer only at their own address and nowhere else; those are listed for honesty and refused for forwarding.",
        ),
    // workspace: dev servers, terminal processes, published container ports. system: agent runtimes, translator,
    // dockerd, sshd.
    kind: z
        .enum(["workspace", "system"])
        .describe("Whether somebody's own work put it there, or the sandbox's own machinery did. Only the first kind is worth previewing."),
    // All three are required, even when nothing can explain the listener ("Unclaimed port"); resolved daemon-side,
    // where the facts that attribute it actually live.
    title: z
        .string()
        .describe(
            "What a person would call it. Always present: a listener nothing can explain is still named, because the button beside it publishes the port to the internet.",
        ),
    purpose: z.string().describe("One sentence about what it is for, including when the honest answer is that nothing could work it out."),
    origin: z
        .enum(["terminal", "agent", "panel", "extension", "container", "sandbox", "unknown"])
        .describe("Who put it there, which is the question somebody is really asking: mine, my agent's, or the box's own."),
    // Resolved via /proc/*/fd matching the socket's inode.
    pid: z.number().optional().describe("The process holding it. Absent when nothing could be matched to the socket."),
    // Process argv joined with spaces, falling back to the kernel `comm` name, or a synthesized name when the pid walk
    // can't reach it.
    command: z.string().optional().describe("The command behind it, as it was run. Absent only when nothing could be attributed at all."),
    cwd: z.string().optional().describe("Where it is running from, which is how a port gets attributed to a repository."),
    // Absent for daemon-managed runtimes and published container ports, which have no pane to open.
    session: z
        .string()
        .optional()
        .describe(
            'The terminal it came from, to watch it in or stop it from. Absent when nothing in its ancestry is one, which is the honest "you cannot reach this from here".',
        ),
    // A job an agent's turn left running for the person (AgentSummary.jobs[].handed); ports listed anywhere else stay
    // unclaimed by any conversation.
    job: z
        .object({
            conversationId: z.string().describe("The conversation whose turn left it running."),
            jobId: z.string().describe("The job, as that conversation's card names it; stopping it stops this port."),
            label: z.string().describe("What the job is, in the agent's own words when it gave any."),
        })
        .optional()
        .describe("The background job an agent left running for you on this port, when that is what answers here."),
    forwarded: z.boolean().describe("Whether it is currently reachable from outside."),
    // `https://port-<slot>-<sandboxId>.<zone>`.
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
export const PortForwardResultSchema = z.object({
    previewUrl: z
        .string()
        .optional()
        .describe("Where it can now be reached. Absent on a sandbox with no outside address, where the mapping exists but has no public name."),
});
export type PortForwardResult = z.infer<typeof PortForwardResultSchema>;

// THE OWNER'S GUARD ON PREVIEWS (2026-10-27, docs/architecture/sandbox.md). Off, a preview is open to anyone with its
// address, as it always was; `panels` asks a visitor of a panel's preview (`preview-<panel>-<id>`) for this sandbox's
// pass, which only its members get; `all` asks it of forwarded ports (`port-<slot>-<id>`) too. The outbox is public
// whatever this says. Ports are left out of `panels` because their names are salted already, and they are where a
// webhook or a phone app with no browser to sign in calls.
export const PreviewGuardScopeSchema = z.enum(["off", "panels", "all"]);
export type PreviewGuardScope = z.infer<typeof PreviewGuardScopeSchema>;
export const PreviewGuardSchema = z.object({
    scope: PreviewGuardScopeSchema.default("off").describe(
        "Who may open this sandbox's previews from outside: anyone with the address (`off`), only its members for panel previews (`panels`), or only its members for panel previews and forwarded ports alike (`all`). The outbox stays public.",
    ),
});
export type PreviewGuard = z.infer<typeof PreviewGuardSchema>;
export const PreviewPassRequestSchema = z.object({
    url: z.string().min(1).max(4096).describe("The preview address to open, at the path to open it on."),
});
export const PreviewPassSchema = z.object({
    url: z
        .string()
        .describe(
            "Where to send the browser: the same address through a one-time link that signs this browser in to it, or the address unchanged when nothing guards it.",
        ),
});
export type PreviewPass = z.infer<typeof PreviewPassSchema>;
