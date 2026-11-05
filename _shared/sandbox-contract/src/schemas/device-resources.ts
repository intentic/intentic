import { z } from "zod";

// One sandbox's resource share as docker currently enforces it, read off the container by the machine agent.
// `overlayRuntime` is the environment's locked demand; `hostRuntime` is the owner's addition; `privileged`/`gpu` are
// docker's enforced truth.
// A delta against what runs: absent means leave it, `null` on the two caps means back to the default; at least one key
// must be set. What the old `reshape` op carries, which the machine agent carries out as `ic sandbox shape --set` (its
// `olderResizePlan`); `set-shape` carries a whole shape instead.
export const SandboxResourcesAskFieldsSchema = z.object({
    memoryGib: z.int().positive().nullable().optional(),
    cpus: z.int().positive().nullable().optional(),
    privileged: z.boolean().optional(),
    gpu: z.boolean().optional(),
});
// A sandbox's shape, WHOLE: the owner's own ask for its share of the machine, every field a value. `null` on a cap is
// the contract's default (the share derived from the engine, or every core). The switches are the owner's ask, not
// docker's answer: a directive the approved environment demands rides beside it (`overlayRuntime`), and a host
// without the NVIDIA runtime drops the GPU. `ic` stores it, validates it against the image's run contract when it is
// saved, and prints it in `ic sandbox list --json`; nobody else merges anything into it.
//
// `swapGib` (2026-11-05) is the one field that may be absent: ABSENT is an ic or a machine agent from before it, which
// neither reports nor takes it (an older agent's reading strips it, and its strict order schema refuses it), so a caller
// sends it only to a machine whose report carried it. `null` is the default, a value is the owner's ask.
export const SandboxShapeSchema = z.object({
    memoryGib: z.int().positive().nullable(),
    cpus: z.int().positive().nullable(),
    privileged: z.boolean(),
    gpu: z.boolean(),
    swapGib: z
        .int()
        .positive()
        .nullable()
        .optional()
        .describe(
            "Whole GiB of swap the sandbox's work (its `workload` cgroup) may page into, the swap alone, not memory plus swap; null for the default, a quarter of the memory cap between 1 and 4 GiB (@intentic/sandbox-run defaultSandboxSwapGib). Changed alone and now, ic applies it to the running sandbox without a restart. Absent from an ic or agent older than it.",
        ),
});
export type SandboxShape = z.infer<typeof SandboxShapeSchema>;
// When a `set-shape` takes effect: `now` restarts the sandbox onto it; `nextRestart` saves it in ic's record and
// restarts nothing, and the next restart through ic applies it — Restart or Start from any door, an update, a rollback
// or a rebuild. Docker restarting the container by itself (after a crash or a reboot) does not: only ic recreates one.
export const SandboxShapeWhenSchema = z.enum(["now", "nextRestart"]);
export type SandboxShapeWhen = z.infer<typeof SandboxShapeWhenSchema>;

export const SandboxResourcesSchema = z.object({
    // The cgroup memory ceiling in bytes; absent when docker imposes none (the hosted shape).
    memoryBytes: z.number().optional(),
    // The CFS quota as whole cores; absent when the container may use every core (the default).
    cpus: z.number().optional(),
    privileged: z.boolean(),
    gpu: z.boolean(),
    hostRuntime: z.array(z.string()),
    overlayRuntime: z.array(z.string()),
    // The shape the container runs with (the owner's ask it carries). Absent from an agent older than `set-shape`.
    shape: SandboxShapeSchema.optional(),
    // The shape saved for the sandbox's next restart through ic, and not yet in force. Absent when nothing is saved.
    desired: SandboxShapeSchema.optional(),
    // READ-ONLY, from agents older than `set-shape`: their saved share, a delta against what runs. Nothing new writes
    // it; kept one release so a newer page can still show what an older agent saved. Remove with `later`.
    saved: SandboxResourcesAskFieldsSchema.optional(),
    // (2026-11-05) The swap bound IN FORCE, read by ic inside the running container from the kernel's own files, never
    // from docker: an engine without swap-limit support records MemorySwap -1 whatever it was asked, and drops the bound.
    swapMaxBytes: z
        .number()
        .nullable()
        .optional()
        .describe(
            "The container's own swap bound as /sys/fs/cgroup/memory.swap.max inside it holds it, in bytes; null when unbounded. Absent when it was not read: the sandbox is not running, did not answer in time, or ic is older than this field.",
        ),
    workloadSwapMaxBytes: z
        .number()
        .nullable()
        .optional()
        .describe(
            "The swap bound of the sandbox's work (/sys/fs/cgroup/workload/memory.swap.max: everything but the daemon and netd), in bytes; null when unbounded. Absent when it was not read, or the image is older than the bound a sandbox holds its own work to.",
        ),
});
export type SandboxResources = z.infer<typeof SandboxResourcesSchema>;

// Fields also exported separately for callers that compose them and enforce the at-least-one rule themselves.
// Strict like every device input (DeviceSandboxFlowSchema says why): it is only ever sent to a device.
export const SandboxResourcesAskSchema = SandboxResourcesAskFieldsSchema.strict().refine((ask) => Object.values(ask).some((value) => value !== undefined), {
    message: "a reshape must change at least one thing",
});
export type SandboxResourcesAsk = z.infer<typeof SandboxResourcesAskSchema>;

