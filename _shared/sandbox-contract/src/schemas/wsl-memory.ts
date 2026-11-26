import { z } from "zod";

/* A WSL2 VM TOO BIG FOR THE PC IT RUNS ON (2026-11-26). rog (31.4 GiB) gives its VM `memory=22GB` in `.wslconfig`, and
   the VM keeps what it is given: Windows sat at 2-5 GiB available for hours, under its 3.1 GiB low line
   (hostMemoryLowBytes, hosts.ts), with vmmemWSL holding 16.6 GiB in RAM. Dropping the VM's file cache gives back a
   fraction of a gigabyte (machine `environments/windows-memory.ts`): the size itself is what does not fit. So the
   Windows side's agent watches Windows' available memory and the VM's own footprint for hours, and when Windows has
   been under its low line most of that time while the VM held a large share, it works out a `memory=` that leaves
   Windows its own use, the low line and a margin (machine `environments/wsl-memory-fit.ts`), and reports it in its
   facts (`DeviceFacts.wslMemory`). The daemon raises a `wsl-memory` card for the owner (needs.ts), and their yes runs
   the agent's `wsl-memory` op (DeviceAgentOpSchema), which rewrites that one line of `.wslconfig` with a backup beside
   it. It takes effect only when WSL restarts, which restarts every sandbox on that PC: the owner does that. */

export const WslMemoryCapSchema = z.object({
    name: z.string().min(1).describe("The sandbox, as ic lists it."),
    memoryBytes: z.number().positive().describe("Its container's memory cap, in bytes."),
});
export type WslMemoryCap = z.infer<typeof WslMemoryCapSchema>;

export const WslMemoryFitSchema = z.object({
    at: z.number().describe("When the agent decided, in epoch ms."),
    windowMs: z.number().positive().describe("How long the readings it decided on span, in ms."),
    readings: z.number().int().positive().describe("How many readings that is."),
    totalBytes: z.number().positive().describe("Windows' physical memory."),
    lowLineBytes: z.number().positive().describe("Windows' low line (hostMemoryLowBytes): under it the host counts as short."),
    underLowShare: z.number().min(0).max(1).describe("The share of the readings in which Windows had less available than its low line."),
    availableMedianBytes: z.number().nonnegative().describe("Windows' available memory, the median of the readings."),
    vmMedianBytes: z.number().nonnegative().describe("The VM's footprint in RAM (vmmemWSL's working set), the median of the readings."),
    outsideBytes: z
        .number()
        .nonnegative()
        .describe("Windows' own use outside the VM (total - available - the VM's working set) at the high percentile the proposal rests on."),
    configuredGb: z.number().positive().optional().describe("`memory=` as `.wslconfig` sets it now, in GB (WSL reads them as GiB). Absent: not set."),
    proposedGb: z.number().int().positive().describe("The `memory=` the agent proposes, in whole GB."),
    atFloor: z.boolean().describe("The proposal is the floor that still runs one sandbox: less would fit Windows, but nothing would run."),
    capsOver: z.array(WslMemoryCapSchema).optional().describe("Sandboxes on this PC whose container cap is larger than the proposal."),
    text: z.string().min(1).describe("What was measured and what is proposed, in the agent's words (English)."),
});
export type WslMemoryFit = z.infer<typeof WslMemoryFitSchema>;

export const WslMemorySchema = z.object({
    configPath: z.string().min(1).describe("The `.wslconfig` the agent reads and would write."),
    configuredGb: z.number().positive().optional().describe("`memory=` in its `[wsl2]` section, in GB. Absent: not set, so WSL gives the VM half the RAM."),
    fit: WslMemoryFitSchema.optional().describe("Present when the VM is too big for this PC: what was measured and the size proposed."),
});
export type WslMemory = z.infer<typeof WslMemorySchema>;

// The need it raises (one of needs.ts `NeedSubjectSchema`'s kinds, kept here beside what it carries): the WSL2 VM of the
// PC this sandbox runs on is too big for it. Raised by the daemon itself, never by an agent's ask, in the conversation a
// person spoke in; a person's yes runs the PC's `wsl-memory` op, which writes `fit.proposedGb` into `.wslconfig`.
// Nothing changes until WSL restarts, which restarts every sandbox on that PC: that is the owner's to do. Its outcome is
// the person's alone: no agent hears it.
export const WslMemoryNeedSchema = z.object({
    kind: z.literal("wsl-memory"),
    device: z.string().min(1).describe("The connected PC this sandbox runs on, by its device id (Windows' own side)."),
    configPath: z.string().min(1).describe("The `.wslconfig` a yes writes."),
    fit: WslMemoryFitSchema.describe("What was measured and the size proposed, as read when the card was raised."),
});
export type WslMemoryNeed = z.infer<typeof WslMemoryNeedSchema>;
