import { z } from "zod";

// What the sandbox is using right now, measured only when asked (GET /system/metrics). CPU percentages are of ONE core
// unless the field says otherwise; memory is resident bytes.

// The kinds of process a sandbox runs, as the daemon classifies them by command line.
export const PROCESS_ROLES = [
    "languageServer",
    "searchEngine",
    "agentRuntime",
    "browser",
    "git",
    "translator",
    "extension",
    "terminal",
    // A build, test, typecheck or lint run and the package manager driving it: the fan-out shape, which is what every
    // memory peak the resource log has recorded was made of.
    "toolchain",
    // An inference server this sandbox runs for itself.
    "localModel",
    // A process of a nested Docker container: charged to this cgroup, visible to nothing else here.
    "container",
    "other",
] as const;
export const ProcessRoleSchema = z.enum(PROCESS_ROLES);
export type ProcessRole = z.infer<typeof ProcessRoleSchema>;

export const ProcessGroupMetricsSchema = z.object({
    processes: z.number().describe("How many processes."),
    rssBytes: z
        .number()
        .describe(
            "Their resident memory added up, in bytes. Memory two processes share is counted in each, so this can exceed what they cost together.",
        ),
});
export type ProcessGroupMetrics = z.infer<typeof ProcessGroupMetricsSchema>;

export const SessionMetricsSchema = ProcessGroupMetricsSchema.extend({
    cpuPercent: z
        .number()
        .optional()
        .describe(
            "CPU its processes used over the window, as a percentage of one core, so a conversation busy on four cores reads 400. Counts commands that finished inside the window too. Absent on a first reading, which has nothing earlier to measure from.",
        ),
});
export type SessionMetrics = z.infer<typeof SessionMetricsSchema>;

// Linux pressure stall information: the share of the last ten seconds in which some task waited on the resource.
export const PressureMetricsSchema = z.object({
    cpu: z.number().describe("Percent of the last ten seconds in which something was waiting for a CPU."),
    memory: z.number().describe("Percent of the last ten seconds in which something was waiting on memory: reclaim, swap-in, or a refault."),
    io: z.number().describe("Percent of the last ten seconds in which something was waiting on disk."),
});
export type PressureMetrics = z.infer<typeof PressureMetricsSchema>;

export const SandboxUsageSchema = z.object({
    cpuPercent: z
        .number()
        .optional()
        .describe("CPU the whole sandbox used over the window, as a percentage of all it may use (`cores`). Absent on a first reading."),
    cores: z.number().describe("How many cores the sandbox may use: its CPU quota, or every core it is allowed to run on when it has none."),
    memoryBytes: z
        .number()
        .describe("Memory in use, less the file cache the kernel takes back on demand: the figure that runs into the limit."),
    memoryLimitBytes: z.number().describe("The memory limit: the container's own, or the machine's memory when the container has none."),
    swapBytes: z.number().optional().describe("Memory pushed out to swap. Absent where the sandbox cannot see its own swap."),
    diskBytes: z.number().optional().describe("Space used on the volume the workspace lives on. Absent when the volume would not say."),
    diskTotalBytes: z.number().optional().describe("That volume's size. Absent when the volume would not say."),
    loadAverage: z
        .tuple([z.number(), z.number(), z.number()])
        .describe("The load average over 1, 5 and 15 minutes. It is the machine's, so other sandboxes on it count too."),
    processes: z.number().describe("How many processes are running in the sandbox."),
    pressure: PressureMetricsSchema.optional().describe("How much work waited on CPU, memory or disk lately. Absent where the kernel does not report it."),
});
export type SandboxUsage = z.infer<typeof SandboxUsageSchema>;

export const DaemonUsageSchema = z.object({
    rssBytes: z.number().describe("The daemon's own resident memory."),
    heapUsedBytes: z.number().describe("Of that, JavaScript objects in use."),
    cpuPercent: z.number().optional().describe("CPU the daemon itself used over the window, as a percentage of one core. Absent on a first reading."),
    eventLoopPercent: z
        .number()
        .optional()
        .describe(
            "How much of the window the daemon spent busy rather than waiting. Near 100, every request queues behind whatever it is doing. Absent on a first reading.",
        ),
});
export type DaemonUsage = z.infer<typeof DaemonUsageSchema>;

export const SandboxMetricsSchema = z.object({
    at: z.number().describe("When this reading was taken, in milliseconds."),
    windowMs: z
        .number()
        .optional()
        .describe("How long the CPU figures were measured over, in milliseconds. Absent on a first reading, and then so is every CPU figure."),
    sandbox: SandboxUsageSchema.describe("The sandbox as a whole."),
    daemon: DaemonUsageSchema.describe("The daemon that runs it, which none of the other figures include."),
    sessions: z
        .record(z.string(), SessionMetricsSchema)
        .describe(
            "What each conversation's processes use, by conversation id: the agent's own process and everything it started. Only conversations with processes running, and only those the caller may see.",
        ),
    roles: z
        .partialRecord(ProcessRoleSchema, ProcessGroupMetricsSchema)
        .describe("Every process in the sandbox but the daemon, by what kind of work it is. A kind with nothing running is absent."),
});
export type SandboxMetrics = z.infer<typeof SandboxMetricsSchema>;
