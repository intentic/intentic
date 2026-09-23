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

// What is filling the sandbox's disk, by what it is for (GET /system/storage). Sizes are apparent bytes, and a file
// with several hard links counts once, toward the first place the scan met it.

// Every category a byte on the sandbox's volumes can belong to; STORAGE_CLEANABILITY below says which may be cleaned.
export const STORAGE_CATEGORIES = [
    // The workspace's own files: repositories, their dependencies, anything the owner or an agent put there.
    "workspace",
    // Transcripts, runtime session stores, attachments and loop memory of every conversation, archived ones included.
    "conversations",
    // Each open conversation's own checkout of the repositories, and the dependencies its turns installed over them.
    "checkouts",
    // The minute-by-minute and per-turn snapshots the History timeline restores from.
    "restorePoints",
    // The repositories' own git data: every commit and branch, pushed or not.
    "repositories",
    // Installed versions of the agent runtimes: the one turns use and the one kept for Revert.
    "engines",
    // Search indexes and caches the sandbox keeps up to date by itself while it runs.
    "indexes",
    // Installed extensions and their scratch.
    "extensions",
    // The sandbox's own Docker: images, containers, volumes.
    "docker",
    // Settings, credentials, sign-ins and the ledgers of what was spent and done.
    "state",
    // Anything no part of the sandbox claims.
    "other",
    // Git data and checkouts of repositories deleted from the workspace.
    "trash",
    // Copies of the sandbox packed for download.
    "exports",
    // Files agents produced: generated images, reports, harness output.
    "artifacts",
    // Screenshots and page snapshots the agent's browser took.
    "browserCaptures",
    // The agent browser's profiles, with the sites it is signed in to.
    "browserProfiles",
    // Weights downloaded for local models.
    "modelWeights",
    // The sandbox's own logs and terminal captures.
    "logs",
    // Scratch space agents and checks leave behind.
    "scratch",
    // Package managers' content stores, which the next install refills.
    "packageStores",
    // Build tools' output caches.
    "buildCaches",
] as const;
export const StorageCategoryIdSchema = z.enum(STORAGE_CATEGORIES);
export type StorageCategoryId = z.infer<typeof StorageCategoryIdSchema>;

// none: never removed from here; safe: comes back by itself, removed without asking; confirm: removed only once the
// owner has read what it costs.
export const StorageCleanabilitySchema = z.enum(["none", "safe", "confirm"]);
export type StorageCleanability = z.infer<typeof StorageCleanabilitySchema>;

// Which categories may be cleaned, and which ask first: the daemon's cleaner refuses by it, the editor words its
// confirm by it. State, credentials and live work are `none`; what regenerates is `safe`; the owner's own data asks.
export const STORAGE_CLEANABILITY = {
    workspace: "none",
    conversations: "none",
    // A live conversation's working copy; archiving the conversation is what frees it.
    checkouts: "none",
    // No compaction is safe to offer: `git gc --auto` already runs after every snapshot, and every object is reachable.
    restorePoints: "none",
    repositories: "none",
    // The Engines card keeps two versions and owns which is which; removing one here would strand its Revert.
    engines: "none",
    // Held open by what maintains them: removing a file frees nothing until they close it.
    indexes: "none",
    extensions: "none",
    docker: "none",
    state: "none",
    other: "none",
    // Nothing reads it again, but it may hold commits never pushed anywhere.
    trash: "confirm",
    exports: "confirm",
    artifacts: "confirm",
    browserCaptures: "confirm",
    browserProfiles: "confirm",
    modelWeights: "confirm",
    logs: "safe",
    scratch: "safe",
    packageStores: "safe",
    buildCaches: "safe",
} as const satisfies Record<StorageCategoryId, StorageCleanability>;

export const StorageItemSchema = z.object({
    path: z.string().describe("Where it is, as an absolute path inside the sandbox."),
    bytes: z.number().describe("Its size in bytes."),
});
export type StorageItem = z.infer<typeof StorageItemSchema>;

export const StorageCategoryUsageSchema = z.object({
    id: StorageCategoryIdSchema,
    cleanability: StorageCleanabilitySchema.describe("Whether this category can be cleaned from here, and whether cleaning it asks first."),
    bytes: z.number().describe("Its size in bytes."),
    files: z.number().describe("How many files it holds."),
    cleanableBytes: z
        .number()
        .optional()
        .describe(
            "What cleaning it would free right now: only what is old enough and not in use. Absent where nothing here may be cleaned, and for a package store, whose own tool decides what no project needs.",
        ),
    items: z.array(StorageItemSchema).describe("Its biggest parts, largest first, at most eight."),
});
export type StorageCategoryUsage = z.infer<typeof StorageCategoryUsageSchema>;

export const StorageScanSchema = z.object({
    startedAt: z.number().describe("When the scan began, in milliseconds."),
    finishedAt: z.number().describe("When it ended, in milliseconds: the moment these sizes describe."),
    outcome: z
        .enum(["complete", "partial"])
        .describe("`partial` when the scan hit its time limit first, so every size is at least what it says rather than exactly it."),
    disk: z
        .object({
            usedBytes: z.number().describe("Space used on the volume the workspace lives on."),
            totalBytes: z.number().describe("That volume's size."),
        })
        .optional()
        .describe("The volume as a whole. Absent when the volume would not say."),
    categories: z.array(StorageCategoryUsageSchema).describe("Every category that holds anything, largest first."),
    unreadable: z.number().describe("Files and folders the scan could not read, and so did not count."),
});
export type StorageScan = z.infer<typeof StorageScanSchema>;

export const StorageReportSchema = z.object({
    scan: StorageScanSchema.optional().describe("The last scan that finished. Absent until one has, and again after the daemon restarts."),
    scanning: z.boolean().describe("Whether a scan is running now."),
});
export type StorageReport = z.infer<typeof StorageReportSchema>;

export const StorageCleanInputSchema = z.object({
    category: StorageCategoryIdSchema.describe("The category to clean; one whose cleanability is `none` is refused."),
});
export type StorageCleanInput = z.infer<typeof StorageCleanInputSchema>;

export const StorageCleanResultSchema = z.object({
    category: StorageCategoryIdSchema,
    freedBytes: z.number().describe("Space the removals gave back, in bytes. A file that is still linked elsewhere frees nothing and is not counted."),
    removed: z.number().describe("How many items were removed."),
    kept: z
        .number()
        .describe("How many were left in place: changed too recently, in use by a running program, or no longer this category's."),
    failed: z.number().describe("How many removals the filesystem refused."),
});
export type StorageCleanResult = z.infer<typeof StorageCleanResultSchema>;
