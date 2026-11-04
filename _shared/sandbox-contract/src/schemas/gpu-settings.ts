// The host GPU settings, apart from settings.ts for its size; settings.ts re-exports them for every reader.
import { z } from "zod";

/* THE HOST GPU, FOR A SANDBOX WHOSE GPU SWITCH IS ON (2026-11-03). On a Windows PC that GPU is the owner's display GPU,
   shared through WSL (/dev/dxg). Until 2026-11-03 the engine put its driver libraries on every process's library path,
   so 65 conversations' browsers and shells rendered on it unasked, and one GPU hang powered rog off. Now nothing uses it
   unless asked: `gpu-run <command>` runs one command with it (bin/gpu-run), and `shells: "all"` gives it to every
   command an agent runs. Read by the daemon (gpu/gpu-state.ts), which hands gpu-run what it needs in a state file. */
export const GpuShellsSchema = z.enum(["on-request", "all"]);
export const GpuSettingsSchema = z.object({
    shells: GpuShellsSchema.default("on-request").describe(
        "Which of an agent's commands may use this sandbox's GPU. `on-request` (the default): only a command run through `gpu-run`, so a browser, a test run or a build never lands on your display GPU by accident. `all`: every command an agent runs, as if each one went through gpu-run.",
    ),
    timeoutMinutes: z
        .number()
        .int()
        .min(0)
        .max(24 * 60)
        .default(0)
        .describe("How long one gpu-run command may run before it is stopped, in minutes. Zero (the default) never stops it; `gpu-run --timeout` sets it for one command."),
    // Written by the daemon when the computer this sandbox runs on reported a GPU reset (hosts/host-crashes.ts); cleared
    // by the owner, which is the "resume" press. A sentence, so whoever reads the file sees why.
    pausedFor: z
        .string()
        .max(400)
        .optional()
        .describe(
            "Set by the sandbox when the computer it runs on reported that its GPU was reset or hung, naming the event: while it is set, gpu-run refuses, and every command runs without the GPU. Clear it once you have looked, to let agents use the GPU again.",
        ),
});
export type GpuSettings = z.infer<typeof GpuSettingsSchema>;
