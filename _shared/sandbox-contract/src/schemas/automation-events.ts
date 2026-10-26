import { z } from "zod";

// What the daemon emits as the fleet works, for a code chore to react to; no token or route, since only the daemon
// reads these.
// turn.settled: fires once per isolated turn regardless of outcome, while the diff is still on screen
// agent.landed: fires only once work reaches the main tree, including a later manual Land
// deps.broken/deps.fixed: retired with the check that ran after every land (2026-09-27). Nothing emits them any more;
// they stay so an automation written for them still reads, and it never fires. Main's failing CI is the `ci` listener's.
export const WorkspaceEventKindSchema = z.enum(["turn.settled", "agent.landed", "deps.broken", "deps.fixed"]);
export type WorkspaceEventKind = z.infer<typeof WorkspaceEventKindSchema>;
// Payload of a workspace-triggered wake, delivered as JSON in $AUTOMATION_PAYLOAD and appended to the prompt.
// `repos[].from` is each repo's state before the turn; the span runs to the working tree, not a commit, so an errored
// turn's uncommitted work still shows.
export const WorkspaceEventSchema = z.object({
    event: WorkspaceEventKindSchema,
    agentId: z.string(),
    title: z.string().optional(),
    branch: z.string(),
    // `ready` is a clean turn held on the branch (auto-land off): the moment right before a deliberate Land, when a
    // pre-land review wants to run.
    outcome: z.enum(["landed", "conflict", "ready", "idle", "error"]),
    repos: z.array(z.object({ repo: z.string(), from: z.string(), dir: z.string() })),
    // Present only for `deps.*` events: which project broke, the command and exit code, a bounded log tail, and
    // `attempt` counting consecutive failures since the last pass.
    deps: z
        .object({
            project: z.string(),
            command: z.string(),
            exitCode: z.number(),
            attempt: z.number(),
            logTail: z.string(),
        })
        .optional(),
});
export type WorkspaceEvent = z.infer<typeof WorkspaceEventSchema>;
