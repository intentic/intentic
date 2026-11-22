import { z } from "zod";

// WHAT A CONVERSATION LEAVES GOING BESIDE ITS TURN, as its card carries it (AgentSummarySchema): the commands it left
// running in the background, and the workflow runs it started, which keep starting subagents of their own while the
// conversation rests. Both outlive the turn that started them, so both are a person's to stop from the card.

// In memory only: a daemon restart leaves transcript rows naming jobs this list no longer carries.
export const AgentJobsSchema = z
    .array(
        z.object({
            id: z.string().describe("The daemon's handle for this job, the one its transcript row names."),
            label: z.string().describe("What the job is, in the agent's own words when it gave any, else its command on one line."),
            session: z.string().describe("The terminal session its pane runs in, which is what opening it focuses."),
            startedAt: z.number().describe("When it started, in milliseconds."),
            endedAt: z.number().optional().describe("When the command exited, in milliseconds. Absent while it runs."),
            exitCode: z.number().int().optional().describe("The code it exited with. Absent while it runs, or when its exit left none."),
            // What the turn that left it running decided about it (agent/tools/jobs/job-fates.ts): one of these, or none
            // while its turn is still going.
            watch: z
                .string()
                .optional()
                .describe(
                    "The watch its exit wakes this conversation through. Present once the turn that left it running has ended and the conversation is waiting on it.",
                ),
            handed: z
                .boolean()
                .optional()
                .describe(
                    "Left running for the person: the agent kept it for them with the `keep` tool (or it holds a port this conversation already left them), so it outlives the turn, wakes nothing and is theirs to stop.",
                ),
            ports: z.array(z.number().int()).optional().describe("The ports it was listening on when its turn ended."),
            stoppedBy: z
                .enum(["turn", "person", "agent"])
                .optional()
                .describe(
                    "Who stopped it: the sandbox, when the turn that used it ended without handing it over; a person; or the agent itself. Present from the moment the stop is asked. Absent for a job that exited by itself.",
                ),
            // agent/tools/jobs/input-wait.ts: told from /proc, never from what it printed, since a prompt can go
            // straight to the terminal or sit in a pipe.
            inputWait: z
                .object({
                    since: z.number().describe("When it went still, in milliseconds."),
                    program: z.string().describe("The process blocked reading the terminal, as its command line."),
                })
                .optional()
                .describe(
                    "Present while it sits blocked reading its terminal with nothing moving: a prompt nobody in the sandbox will answer, which only stopping it or a person typing into its terminal ends. Absent while it runs on, and once it ends.",
                ),
        }),
    )
    .optional()
    .describe(
        "Commands this conversation left running in the background, and how the most recent ones ended. Absent means none since the daemon started. A job is running exactly while it has no end.",
    );

// In memory, as the runs are (agent/subagents/workflows/live-runs.ts): a run a restart picks up is listed again as it goes
// on. A run is a script, not a turn: it keeps starting subagents while the conversation itself rests.
export const AgentScriptRunsSchema = z
    .array(
        z.object({
            id: z.string().describe("The run's id, the one its agent was given (`wfr-…`)."),
            name: z.string().describe("The workflow's name, from its script's `meta`."),
            calls: z.number().int().min(0).describe("How many subagents it has started so far. One run starts at most 200."),
            working: z.number().int().min(0).describe("How many of its subagents are at work now."),
            failed: z.number().int().min(0).describe("How many of its calls failed or were stopped."),
            phase: z.string().optional().describe("The phase its script last marked."),
            startedAt: z.number().describe("When it started, in milliseconds."),
        }),
    )
    .optional()
    .describe(
        "Workflow runs this conversation started that are still going. A run starts subagents of its own until its script ends, whether or not the conversation is running, so stopping its subagents one at a time does not end it: it starts the next. Stopping the run does (`stopFamily`). Absent means none.",
    );
export type AgentScriptRun = NonNullable<z.infer<typeof AgentScriptRunsSchema>>[number];

// Naming a run stops only that run and its subagents; naming none stops everything the conversation has going.
export const AgentStopFamilySchema = z.object({
    id: z.string().min(1).describe("Which conversation."),
    run: z.string().min(1).optional().describe("One of its workflow runs, by the id its card carries. Absent stops its turn, every run and every agent below it."),
});

export const AgentFamilyStoppedSchema = z.object({
    turn: z.boolean().describe("Whether its own turn was running and was stopped."),
    runs: z.number().int().min(0).describe("How many workflow runs were stopped: its own, and those of the agents below it."),
    agents: z.number().int().min(0).describe("How many agents below it had work stopped: a running turn, a start still waiting, a re-run the sandbox had booked."),
});
export type AgentFamilyStopped = z.infer<typeof AgentFamilyStoppedSchema>;
