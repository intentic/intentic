import { z } from "zod";
import { RunnerCommandFrameSchema, RunnerCommandSchema } from "../protocol/doors/runner-protocol.js";
import { AgentHarnessSchema, AgentProviderSchema } from "./agent.js";

// OFFLOADED WORK, as the in-sandbox `offload-run` command and the editor see it (settings `offload`): a heavy line this
// sandbox hands a runner on one of the owner's machines instead of running it itself.

// Whether a runner can take a line right now, asked before the tree is snapshotted, so a machine that is asleep costs
// nothing. `name` is the machine the runner sits on, the word the owner picked it by.
export const OffloadTargetSchema = z.object({
    runner: z.string().min(1),
    name: z.string().min(1),
    ready: z.boolean(),
    // Why not, in the words the command prints before it runs the line here instead.
    why: z.string().optional(),
});
export type OffloadTarget = z.infer<typeof OffloadTargetSchema>;

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
});
export type OffloadRecord = z.infer<typeof OffloadRecordSchema>;

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

// What made a machine busy or full: memory short of what an agent needs, memory stalling, CPUs saturated, or as many
// agents running as it has slots for.
export const MachineStrainSchema = z.enum(["memory", "memory-stall", "cpu", "agents"]);
export type MachineStrain = z.infer<typeof MachineStrainSchema>;

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
    // Conversations running a turn there now, and how many it holds at once (the fan-out scheduler's own slots).
    agents: z.number().int().nonnegative(),
    slots: z.number().int().positive(),
    // The share of the machine still free by its tightest measure (slots, memory, CPU), so two machines of different
    // sizes compare: 0 is none, 1 is idle.
    headroom: z.number().min(0).max(1),
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
});
export type FleetAdvice = z.infer<typeof FleetAdviceSchema>;
