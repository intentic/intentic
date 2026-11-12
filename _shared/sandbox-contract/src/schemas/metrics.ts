import { z } from "zod";

// What the sandbox is using right now, measured only when asked (GET /system/metrics). CPU percentages are of ONE core
// unless the field says otherwise; memory is in bytes, with admission accounting and process RSS distinguished below.

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
            "Their process resident memory (RSS) added up, in bytes, including file mappings and shared pages counted once per process. This can exceed what they cost together. It excludes unmapped file cache, kernel memory and swapped-out pages.",
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

// The memory figures the daemon admits work by (its resource budget), so a gauge built on them warns exactly when a turn
// would be held.
export const MemoryRoomSchema = z.object({
    freeBytes: z
        .number()
        .optional()
        .describe("The limit less what is used and what work admitted in the last minute and a half still holds. Absent where nothing measures it."),
    reservedBytes: z.number().describe("What work admitted in the last minute and a half holds before it shows in `memoryBytes`."),
    personNeedBytes: z.number().describe("What a person's turn needs free to start without a warning: below it, the sandbox is short."),
    stallPercent: z.number().describe("Percent of the last ten seconds in which everything in the sandbox waited on memory (pressure `full`)."),
    stallLimitPercent: z.number().describe("The stall at or past which the sandbox counts as short of memory, whatever `freeBytes` says."),
    stallSustainedPercent: z
        .number()
        .optional()
        .describe("Percent of the last minute in which everything in the sandbox waited on memory. Absent from a daemon that predates it."),
    stallSustainedLimitPercent: z
        .number()
        .optional()
        .describe("The minute's stall at or past which the sandbox counts as short of memory. Absent from a daemon that predates it."),
});
export type MemoryRoom = z.infer<typeof MemoryRoomSchema>;

export const SandboxUsageSchema = z.object({
    cpuPercent: z
        .number()
        .optional()
        .describe("CPU the whole sandbox used over the window, as a percentage of all it may use (`cores`). Absent on a first reading."),
    cores: z.number().describe("How many cores the sandbox may use: its CPU quota, or every core it is allowed to run on when it has none."),
    memoryBytes: z
        .number()
        .describe(
            "Memory counted against the limit, as the daemon admits work by it: the cgroup's resident charge, including the daemon, kernel memory and file cache except inactive_file, plus swapped bytes only when swap is nearly full (`swapFull`). Falls back to the machine's used memory when the budget cannot measure it.",
        ),
    memoryLimitBytes: z
        .number()
        .describe(
            "The memory limit work is admitted against: where the kernel starts throttling the container (memory.high), else its hard limit, else the machine's memory; never above the workload cgroup leaf's own limit plus what runs outside that leaf, since admitted work runs in it.",
        ),
    memoryBreakdown: z
        .object({
            anonymousBytes: z.number().optional().describe("Anonymous resident memory charged to the cgroup (memory.stat anon), in bytes."),
            countedFileCacheBytes: z
                .number()
                .optional()
                .describe(
                    "File cache counted in resident usage (memory.stat file less inactive_file), in bytes. Absent unless both counters are valid.",
                ),
            kernelBytes: z
                .number()
                .optional()
                .describe("Kernel memory charged to the cgroup (memory.stat kernel), in bytes. Absent on kernels without that aggregate."),
            inactiveFileCacheBytes: z
                .number()
                .optional()
                .describe("Inactive file cache (memory.stat inactive_file), in bytes, excluded from memoryBytes."),
        })
        .optional()
        .describe(
            "Approximate measured memory.stat categories, not an RSS subtraction or an exact sum of memoryBytes: admission is sampled separately and may also count swap. Missing or invalid categories are omitted, not zero. Absent without cgroup memory, on machine-memory fallback, when no category is valid, and from older daemons.",
        ),
    swapBytes: z
        .number()
        .optional()
        .describe(
            "What was pushed out to swap, counted in `memoryBytes` only when swap is nearly full under admission policy. Absent where the sandbox cannot see its own memory.",
        ),
    swapLimitBytes: z.number().optional().describe("What swap can hold. Absent where nothing bounds it, and from a daemon that predates it."),
    swapFull: z
        .boolean()
        .optional()
        .describe(
            "Swap has reached the admission policy's nearly-full threshold against `swapLimitBytes`, so swapped bytes count against the memory limit too, even if swap space remains.",
        ),
    memoryRoom: MemoryRoomSchema.optional().describe("What admission reads off the same reading. Absent from a daemon that predates it."),
    diskBytes: z.number().optional().describe("Space used on the volume the workspace lives on. Absent when the volume would not say."),
    diskTotalBytes: z.number().optional().describe("That volume's size. Absent when the volume would not say."),
    loadAverage: z
        .tuple([z.number(), z.number(), z.number()])
        .describe("The load average over 1, 5 and 15 minutes. It is the machine's, so other sandboxes on it count too."),
    machineCores: z
        .number()
        .optional()
        .describe(
            "Cores the machine's load average reads against: every core the sandbox may be scheduled on, before any quota. Absent from a daemon that predates it.",
        ),
    processes: z.number().describe("How many processes are running in the sandbox, including the daemon."),
    pressure: PressureMetricsSchema.optional().describe(
        "How much work waited on CPU, memory or disk lately. Absent where the kernel does not report it.",
    ),
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
    sandbox: SandboxUsageSchema.describe("The sandbox as a whole, including the daemon."),
    daemon: DaemonUsageSchema.describe(
        "The daemon's own usage, included in the sandbox total and process count but excluded from roles and session sums.",
    ),
    sessions: z
        .record(z.string(), SessionMetricsSchema)
        .describe(
            "What each conversation's processes use, by conversation id: the agent's own process and everything it started, excluding the daemon. These group many of the same process readings as roles, not additional memory. Only conversations with processes running, and only those the caller may see.",
        ),
    roles: z
        .partialRecord(ProcessRoleSchema, ProcessGroupMetricsSchema)
        .describe("Every process in the sandbox but the daemon, by what kind of work it is. A kind with nothing running is absent."),
});
export type SandboxMetrics = z.infer<typeof SandboxMetricsSchema>;

// What is filling the sandbox's disk, by what it is for (GET /system/storage). Sizes are apparent bytes, and a file
// with several hard links counts once, toward the first place the scan met it.

// none: never removed from here; safe: comes back by itself, removed without asking; confirm: removed only once the
// owner has read what it costs.
export const StorageCleanabilitySchema = z.enum(["none", "safe", "confirm"]);
export type StorageCleanability = z.infer<typeof StorageCleanabilitySchema>;

// Every category a byte on the volumes can belong to, and its cleanability: the cleaner refuses by it, the editor words its confirm by it.
export const STORAGE_CLEANABILITY = {
    // The workspace's own files: repositories, their dependencies, anything the owner or an agent put there.
    workspace: "none",
    // Transcripts, runtime session stores, attachments and loop memory of every conversation, archived ones included.
    conversations: "none",
    // Each open conversation's own checkout of the repositories and the dependencies its turns installed; archiving the conversation frees it.
    checkouts: "none",
    // Per-turn and minute-by-minute snapshots History restores from; no compaction to offer: `git gc --auto` runs after each, all is reachable.
    restorePoints: "none",
    // The repositories' own git data: every commit and branch, pushed or not.
    repositories: "none",
    // Installed agent runtimes, the one turns use and the one kept for Revert; the Engines card owns which is which, so removing one strands it.
    engines: "none",
    // Search indexes and caches the sandbox keeps up to date while it runs, held open by it: removing a file frees nothing until it closes.
    indexes: "none",
    // Installed extensions and their scratch.
    extensions: "none",
    // The sandbox's own Docker: images, containers, volumes.
    docker: "none",
    // Settings, credentials, sign-ins and the ledgers of what was spent and done.
    state: "none",
    // Anything no part of the sandbox claims.
    other: "none",
    // Git data and checkouts of repositories deleted from the workspace; nothing reads it again, but it may hold commits never pushed.
    trash: "confirm",
    // Transcripts as they were before the sandbox converted them to its current format; nothing reads them again.
    backups: "confirm",
    // Copies of the sandbox packed for download.
    exports: "confirm",
    // Files agents produced: generated images, reports, harness output.
    artifacts: "confirm",
    // Screenshots and page snapshots the agent's browser took.
    browserCaptures: "confirm",
    // The agent browser's profiles, with the sites it is signed in to.
    browserProfiles: "confirm",
    // Weights downloaded for local models.
    modelWeights: "confirm",
    // What agents' tools downloaded and built in the workspace's cache folder, one folder per tool: Python environments,
    // model weights, package downloads. Comes back only by downloading or building it again.
    toolCaches: "confirm",
    // The sandbox's own logs and terminal captures.
    logs: "safe",
    // Scratch space agents and checks leave behind.
    scratch: "safe",
    // Package managers' content stores, which the next install refills.
    packageStores: "safe",
    // Build tools' output caches.
    buildCaches: "safe",
    // What builds left inside conversation checkouts (a Rust `target/`, Gradle and Flutter output): only checkouts whose
    // conversation has nothing running are cleaned, and their next build makes it again. The checkout itself stays.
    buildOutputs: "safe",
} as const satisfies Record<string, StorageCleanability>;
export type StorageCategoryId = keyof typeof STORAGE_CLEANABILITY;
export const StorageCategoryIdSchema = z.enum(Object.keys(STORAGE_CLEANABILITY) as StorageCategoryId[]);

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

// One conversation's directories on the history volume as the scan measured them (2026-11-03): every checkout, not the
// eight biggest a category lists, so the Storage card can say which conversation holds what.
// The checkout shapes are named, never inferred, like agent-press.ts's: spelled out inside the two storage routes they
// took the aggregated contract's type past what the declaration emitter will write (TS7056).
const CheckoutSizeFields = z.object({
    id: z.string().describe("The directory's name under worktrees/ or overlays/: a conversation id, whether or not a conversation still owns it."),
    bytes: z.number().describe("The checkout without its build output: the repositories' files and anything else its turns wrote there."),
    buildOutputBytes: z.number().describe("Build output inside the checkout (a Rust `target/`, Gradle and Flutter output)."),
    overlayBytes: z.number().describe("What its turns installed over the main tree's dependencies."),
});
export interface CheckoutSize {
    readonly id: string;
    readonly bytes: number;
    readonly buildOutputBytes: number;
    readonly overlayBytes: number;
}
export const CheckoutSizeSchema: z.ZodType<CheckoutSize, CheckoutSize> = CheckoutSizeFields;

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
    checkouts: z
        .array(CheckoutSizeSchema)
        .optional()
        .describe("Every conversation directory on the history volume, largest first. Absent from a scan made before this was measured."),
    unreadable: z.number().describe("Files and folders the scan could not read, and so did not count."),
});
export type StorageScan = z.infer<typeof StorageScanSchema>;

// Where a measured checkout stands now, for what may be done with it: `working` has a turn, a background command or a
// child at work in it; `held` has work nobody has landed; `archived` is a conversation put away whose checkout is still
// on disk; `leftover` is a directory no conversation owns.
export type CheckoutState = "working" | "idle" | "held" | "landed" | "archived" | "leftover";
export const CheckoutStateSchema: z.ZodType<CheckoutState, CheckoutState> = z.enum(["working", "idle", "held", "landed", "archived", "leftover"]);

export interface CheckoutUsage extends CheckoutSize {
    readonly state: CheckoutState;
    readonly title?: string | undefined;
    readonly updatedAt?: number | undefined;
    readonly can: { readonly cleanBuildOutput: boolean; readonly release: boolean; readonly trash: boolean };
}
export const CheckoutUsageSchema: z.ZodType<CheckoutUsage, CheckoutUsage> = CheckoutSizeFields.extend({
    state: CheckoutStateSchema,
    title: z.string().optional().describe("The conversation's title, when it has one."),
    updatedAt: z.number().optional().describe("When the conversation last moved, in milliseconds. Absent for a leftover."),
    can: z
        .object({
            cleanBuildOutput: z.boolean().describe("Its build output may be removed now: it has some, and nothing runs in the conversation."),
            release: z
                .boolean()
                .describe(
                    "Its checkout may be freed now: what it holds is committed onto its branch, the checkout and overlay go, and its next turn brings them back.",
                ),
            trash: z.boolean().describe("A leftover that may be moved to the trash now, where it waits a while before it is emptied."),
        })
        .describe("What may be done with it now, by the same rules the daemon applies when asked."),
});

const StorageReportFields = z.object({
    scan: StorageScanSchema.optional().describe(
        "The last scan that finished, kept across restarts; its `finishedAt` says how old it is. Absent until one has.",
    ),
    scanning: z.boolean().describe("Whether a scan is running now."),
    historyDisk: z
        .object({
            freeBytes: z.number().describe("Space available to the sandbox on the history volume, measured now."),
            totalBytes: z.number().describe("The history volume's total size."),
            floorBytes: z.number().describe("Space kept free before a new checkout: 2% of this volume clamped to 5–20 GiB."),
            low: z.boolean().describe("Whether available history space is below the checkout floor."),
        })
        .optional()
        .describe("The filesystem holding conversation checkouts, independent of the workspace volume. Absent if unreadable."),
    repositoryCheckouts: z
        .array(
            z.object({
                repo: z.string().describe("The live repository's workspace-relative id, or root for the workspace repository."),
                head: z.string().describe("The commit whose tracked blobs were measured."),
                bytes: z.number().describe("The sum of blob sizes at this HEAD: the estimated bytes for one full checkout."),
            }),
        )
        .optional()
        .describe("Live repositories' checkout costs, cached per repository and commit. Repositories without a readable HEAD are omitted."),
    checkouts: z
        .array(CheckoutUsageSchema)
        .optional()
        .describe(
            "The last scan's conversation directories, largest first, each with where its conversation stands now. Sizes are as of the scan; a directory gone since is left out. Absent until a scan has measured them.",
        ),
});
// An interface, named like the checkout shapes above: the report is the output of two routes, each of which spelled it
// out whole, and an alias of the inferred type is spelled out all the same.
export interface StorageReport extends z.infer<typeof StorageReportFields> {}
export const StorageReportSchema: z.ZodType<StorageReport, StorageReport> = StorageReportFields;

export type CheckoutPress = "cleanBuildOutput" | "release" | "trash";
export interface CheckoutPressInput {
    readonly id: string;
    readonly press: CheckoutPress;
}
export const CheckoutPressInputSchema: z.ZodType<CheckoutPressInput, CheckoutPressInput> = z.object({
    id: z.string().describe("The conversation id the directory is named by."),
    press: z.enum(["cleanBuildOutput", "release", "trash"]).describe("What to do with it, as the row's `can` allows."),
});

export interface CheckoutPressResult {
    readonly id: string;
    readonly removed: readonly string[];
}
export const CheckoutPressResultSchema: z.ZodType<CheckoutPressResult, CheckoutPressResult> = z.object({
    id: z.string(),
    removed: z.array(z.string()).describe("Build output folders removed, relative to the checkout; empty for a release or a trash."),
});

// How close the history volume is to full, as the daemon's disk-pressure watch last read it (GET /system/disk-pressure).
// `reaping`: under the settings' `diskReapBelowPercent` free (15% by default), settled checkouts' build output is being
// removed; `low` and `critical` are under 10% and 5%, which the owner is told about once each.
export const DiskPressureLevelSchema = z.enum(["ok", "reaping", "low", "critical"]);
export type DiskPressureLevel = z.infer<typeof DiskPressureLevelSchema>;

export const DiskPressureSchema = z.object({
    level: DiskPressureLevelSchema,
    freeBytes: z.number().describe("Space available on the history volume at the last reading."),
    totalBytes: z.number().describe("The history volume's size."),
    measuredAt: z.number().describe("When it was read, in milliseconds; 0 before the first reading."),
    reaped: z
        .object({
            bytes: z.number().describe("Space the removals gave back, as the volume measured it before and after."),
            checkouts: z.number().describe("How many conversation checkouts had build output removed."),
            at: z.number().describe("When that pass ended, in milliseconds."),
        })
        .optional()
        .describe("The last pass that removed build output because the disk was short. Absent until one has."),
    using: z
        .array(z.object({ id: StorageCategoryIdSchema, bytes: z.number() }))
        .describe("The biggest categories in the last finished storage scan, largest first, at most three; empty before a scan."),
});
export type DiskPressure = z.infer<typeof DiskPressureSchema>;

export const StorageCleanInputSchema = z.object({
    category: StorageCategoryIdSchema.describe("The category to clean; one whose cleanability is `none` is refused."),
});
export type StorageCleanInput = z.infer<typeof StorageCleanInputSchema>;

export const StorageCleanResultSchema = z.object({
    category: StorageCategoryIdSchema,
    freedBytes: z
        .number()
        .describe("Space the removals gave back, in bytes. A file that is still linked elsewhere frees nothing and is not counted."),
    removed: z.number().describe("How many items were removed."),
    kept: z.number().describe("How many were left in place: changed too recently, in use by a running program, or no longer this category's."),
    failed: z.number().describe("How many removals the filesystem refused."),
});
export type StorageCleanResult = z.infer<typeof StorageCleanResultSchema>;
