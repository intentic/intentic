import { z } from "zod";
import { RunnerCommandFrameSchema, RunnerCommandSchema } from "../protocol/doors/runner-protocol.js";
import { AgentHarnessSchema, AgentProviderSchema } from "./agent.js";

// OFFLOADED WORK, as the in-sandbox `offload-run` command and the editor see it (settings `offload`): a heavy line this
// sandbox hands a runner on one of the owner's machines instead of running it itself.

// Whether a runner can take a line right now, asked before the tree is snapshotted, so a machine that is asleep costs
// nothing. `name` is the machine the runner sits on, the word the owner picked it by. Asked for OFFLOAD_ANY_RUNNER, it
// answers with the runner it picked, or not ready with no `why` when this sandbox has room, which runs the line here
// in silence.
export const OffloadTargetSchema = z.object({
    runner: z.string().min(1),
    name: z.string().min(1),
    ready: z.boolean(),
    // Why not, in the words the command prints before it runs the line here instead.
    why: z.string().optional(),
});
export type OffloadTarget = z.infer<typeof OffloadTargetSchema>;

// What a line needs of the machine it runs on, said by whoever starts it (`remote-run --needs mem=12G,gpu`); the
// daemon adds what the line's own profile measured (offload/command-profiles.ts). A machine short of it is never picked.
export const OffloadNeedsSchema = z.object({
    memoryMb: z.number().int().positive().optional(),
    gpu: z.boolean().optional(),
});
export type OffloadNeeds = z.infer<typeof OffloadNeedsSchema>;

// The question `offload-run` asks before it snapshots anything. `eager` (remote-run's) picks the machine with the most
// room that fits even while this sandbox is calm; without it a line leaves only a busy sandbox, or one it does not fit.
// `label` and `command` name the line, so what it measured on earlier runs counts.
export const OffloadTargetInputSchema = z.object({
    runner: z.string().min(1),
    memoryMb: z.coerce.number().int().positive().optional(),
    gpu: z.stringbool().optional(),
    eager: z.stringbool().optional(),
    label: z.string().min(1).max(80).optional(),
    command: z.string().max(4000).optional(),
});
export type OffloadTargetInput = z.infer<typeof OffloadTargetInputSchema>;

// What settings `offload.commands` names instead of one runner: whichever has the most room at the moment the command
// starts, and only while this sandbox is busy or cannot fit the line (runners/fleet-advice.ts `placeCommand`). While
// this sandbox is calm the command runs here without a word. Reserved: no runner is ever enrolled under it.
export const OFFLOAD_ANY_RUNNER = "auto";

export const OffloadRunSchema = RunnerCommandSchema.extend({ runner: z.string().min(1) });
export type OffloadRun = z.infer<typeof OffloadRunSchema>;

// What a run streams back: the runner's own frames, or one refusal when the runner could not take it after all (it went
// offline between the question and the run, or it predates offloading), which sends the line back here.
export const OffloadFrameSchema = z.union([...RunnerCommandFrameSchema.options, z.object({ kind: z.literal("refused"), why: z.string() })]);
export type OffloadFrame = z.infer<typeof OffloadFrameSchema>;

// One offloaded run as the runner card lists it: the recent ones, kept in memory, newest first.
export const OffloadRecordSchema = z.object({
    runId: z.string(),
    runner: z.string(),
    name: z.string(),
    label: z.string(),
    // The line, cut to a readable length.
    command: z.string(),
    startedAt: z.number(),
    endedAt: z.number().optional(),
    code: z.number().int().optional(),
    failure: z.string().optional(),
    // What the runner measured: the most memory the line held at once, and how long it ran there.
    peakMemoryMb: z.number().int().nonnegative().optional(),
    durationMs: z.number().int().nonnegative().optional(),
});
export type OffloadRecord = z.infer<typeof OffloadRecordSchema>;

// What earlier runs of one kind of line measured (offload/command-profiles.ts), keyed by its rule and the parts of the
// line that decide its size (`cargo test -p shinobi-society`, not the test filter after it).
export const CommandProfileSchema = z.object({
    key: z.string().min(1),
    runs: z.number().int().positive(),
    // The most any of the last few runs held: memory is planned for the worst recent run, not the average.
    peakMemoryMb: z.number().int().nonnegative().optional(),
    // A moving average of how long it ran, on whichever machine.
    durationMs: z.number().int().nonnegative().optional(),
    lastAt: z.number(),
});
export type CommandProfile = z.infer<typeof CommandProfileSchema>;

// One kind of heavy work the owner can send elsewhere: a heavy-command rule this sandbox queues (its id, as settings
// `offload.commands` keys it) and the pattern that sorts a line into it.
export const OffloadKindSchema = z.object({ id: z.string().min(1), pattern: z.string() });
export type OffloadKind = z.infer<typeof OffloadKindSchema>;

// NEW SESSIONS ACROSS THE OWNER'S MACHINES (settings `offload.sessions`, GET /offload/placement). One measure for every
// machine, this sandbox and each runner alike, and one judgement over it (runners/fleet-advice.ts), so the composer's
// suggestion, the placement menu and an automatic placement can never disagree about which machine has room.

// What happens to a new session while this machine is busy and another has room: `suggest` says so above the
// composer, `auto` starts it there unless the person keeps it here, `off` says nothing.
export const SessionsPlacementSchema = z.enum(["suggest", "auto", "off"]);
export type SessionsPlacement = z.infer<typeof SessionsPlacementSchema>;

// `calm` takes another agent without anyone noticing; `busy` takes one at a cost to the agents already running; `full`
// would hold or warn a person's next turn (the turn door's own figure).
export const MachineStandingSchema = z.enum(["calm", "busy", "full"]);
export type MachineStanding = z.infer<typeof MachineStandingSchema>;

// What made a machine busy or full: memory short of what an agent needs, memory stalling, CPUs saturated, as many
// agents running as it has slots for, or its disk (the Windows drive under its engine, where that is tighter) too short
// for another agent's checkout and build.
export const MachineStrainSchema = z.enum(["memory", "memory-stall", "cpu", "agents", "disk"]);
export type MachineStrain = z.infer<typeof MachineStrainSchema>;

/* THE COMPUTER UNDER A MACHINE, IN FIGURES ITS OWNER CAN CHECK (2026-11-26). A machine's free memory is the tighter of its
   own budget and its host's room above the line under which the host counts as short (machine-facts.ts), so "1.9 GB
   free" on rog was Windows' Available less a 3.1 GB line nobody could see, while the sandbox itself had 10.5 GB and the
   WSL VM held 16.6 GB of Windows' memory. Said beside the verdict so the composer can name what is short: Windows' own
   figures as Task Manager shows them, and the VM's share and its unused part where that computer's agent reads them.
   Absent where the host says nothing of its memory (a Linux host, an agent older than the reading). */
export const MachineHostSchema = z.object({
    // The computer, by the word the owner knows it by (its device card).
    name: z.string().min(1),
    // What Windows could hand out now (its Available memory, standby cache included), and how much it has.
    availableMb: z.number().int().nonnegative(),
    totalMb: z.number().int().positive(),
    // The line under which it counts as short (hosts.ts hostMemoryLowBytes): never counted as room for new work.
    reserveMb: z.number().int().nonnegative(),
    // The WSL VM's footprint in Windows' memory, and the part of it free inside the VM but too fragmented to hand back
    // (hosts.ts GuestFreeMemorySchema `strandedBytes`); each absent where that computer's agent did not read it.
    vmMb: z.number().int().nonnegative().optional(),
    vmUnusedMb: z.number().int().nonnegative().optional(),
    // What the machine's own budget has free, before its host's room is folded in; absent where nothing measures it.
    ownFreeMb: z.number().int().nonnegative().optional(),
    // Whether the host's room, not the machine's own budget, is what its free memory came to: the host is what is short.
    binding: z.boolean(),
});
export type MachineHost = z.infer<typeof MachineHostSchema>;

export const MachineLoadSchema = z.object({
    standing: MachineStandingSchema,
    // Why it is not calm, strongest first; empty when it is.
    strain: z.array(MachineStrainSchema),
    cpus: z.number().int().positive(),
    // The one-minute load average over the cores: 1 is every core busy.
    load: z.number().nonnegative(),
    // What its resource budget has free, and the limit that is measured against; absent where nothing measures it.
    memoryFreeMb: z.number().int().nonnegative().optional(),
    memoryLimitMb: z.number().int().positive().optional(),
    // What its workspace's disk has free, by the tighter of the volume and the host drive under it.
    diskFreeMb: z.number().int().nonnegative().optional(),
    // Conversations running a turn there now, and how many it holds at once (the fan-out scheduler's own slots).
    agents: z.number().int().nonnegative(),
    slots: z.number().int().positive(),
    // The share of the machine still free by its tightest measure (slots, memory, CPU), so two machines of different
    // sizes compare: 0 is none, 1 is idle.
    headroom: z.number().min(0).max(1),
    // (2026-11-26) The computer it runs on, as that computer's agent last said (MachineHostSchema); absent where it says
    // nothing of its memory.
    host: MachineHostSchema.optional(),
});
export type MachineLoad = z.infer<typeof MachineLoadSchema>;

// Why a new session could not start on a runner right now: the machine is asleep, it has never said how big it is, the
// draft's model signs in with a credential that does not travel, the privacy shield keeps it here, or the person is
// limited to areas a runner cannot fence.
export const FleetUnfitSchema = z.enum(["offline", "unmeasured", "credentials", "privacy", "areas"]);
export type FleetUnfit = z.infer<typeof FleetUnfitSchema>;

export const FleetMachineSchema = z.object({
    runner: z.string().min(1),
    // The machine the runner sits on, the word the owner knows it by.
    name: z.string().min(1),
    online: z.boolean(),
    // Absent while it is offline or has never been measured.
    load: MachineLoadSchema.optional(),
    // Absent when a new session could start there now.
    unfit: FleetUnfitSchema.optional(),
});
export type FleetMachine = z.infer<typeof FleetMachineSchema>;

export const FleetAdviceInputSchema = z.object({
    // The draft's provider and harness, which decide whether its credential can reach a runner; absent reads as the
    // sandbox's defaults.
    agent: AgentProviderSchema.optional(),
    harness: AgentHarnessSchema.optional(),
    // The draft's conversation, which the privacy shield may trust on its own.
    conversationId: z.string().min(1).optional(),
});
export type FleetAdviceInput = z.infer<typeof FleetAdviceInputSchema>;

export const FleetAdviceSchema = z.object({
    mode: SessionsPlacementSchema,
    here: MachineLoadSchema,
    machines: z.array(FleetMachineSchema),
    // Where a new session should start instead of here: absent while here is calm, or when no machine is better off.
    suggestion: z.object({ runner: z.string().min(1), name: z.string().min(1) }).optional(),
    // (2026-11-26) Whether this sandbox could give memory back to the computer it runs on now (POST /system/memory/reclaim):
    // that computer says what memory it has, and the kernel here takes a reclaim. Absent from a daemon older than it.
    reclaim: z.boolean().optional(),
});
export type FleetAdvice = z.infer<typeof FleetAdviceSchema>;

// While this sandbox is full and at least one runner is calm, the machines with room by the word the owner knows each by:
// what a turn is told so that work it can send elsewhere goes there. Absent otherwise.
export const FleetPressureSchema = z.object({ roomy: z.array(z.string().min(1)).min(1) });
export type FleetPressure = z.infer<typeof FleetPressureSchema>;
