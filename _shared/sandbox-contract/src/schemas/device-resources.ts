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
export const SandboxShapeSchema = z.object({
    memoryGib: z.int().positive().nullable(),
    cpus: z.int().positive().nullable(),
    privileged: z.boolean(),
    gpu: z.boolean(),
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
});
export type SandboxResources = z.infer<typeof SandboxResourcesSchema>;

// Fields also exported separately for callers that compose them and enforce the at-least-one rule themselves.
// Strict like every device input (DeviceSandboxFlowSchema says why): it is only ever sent to a device.
export const SandboxResourcesAskSchema = SandboxResourcesAskFieldsSchema.strict().refine((ask) => Object.values(ask).some((value) => value !== undefined), {
    message: "a reshape must change at least one thing",
});
export type SandboxResourcesAsk = z.infer<typeof SandboxResourcesAskSchema>;

