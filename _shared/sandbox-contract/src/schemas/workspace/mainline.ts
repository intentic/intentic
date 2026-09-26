// main-line checks: the whole-tree check the daemon runs after work lands, and what became of what it found
import { z } from "zod";
import { pushFixConversationId } from "../../ids/conversation-ids.js";
import { AgentRunPickSchema } from "../agent.js";

// Nothing is verified inside a conversation any more: a turn ends when the model says it is done, its work lands, and
// the main tree's own check runs afterwards, off everyone's clock, one project at a time. This is that check as the
// editor reads it: what is being measured, what is waiting, what the last run said, and who is working on a red one.

export const MainlineLandSchema = z.object({
    conversationId: z.string().describe("The conversation whose work landed."),
    title: z.string().optional().describe("Its title when it landed."),
    at: z.number().describe("When the land asked for the check, in milliseconds."),
});
export type MainlineLand = z.infer<typeof MainlineLandSchema>;

// A land a red is laid at, as a reader names it.
export const MainlineLandRefSchema = z.object({
    conversationId: z.string().describe("The conversation whose work landed."),
    title: z.string().optional().describe("Its title when it landed."),
});
export type MainlineLandRef = z.infer<typeof MainlineLandRefSchema>;

// One failure a run named, split the way a reader scans it.
export const MainlineFailureSchema = z.object({
    name: z.string().describe("What failed: a test by its own name, anything else (a type error, a whole task) as the check printed it."),
    path: z.string().optional().describe("The repository path it failed in, when it names one."),
});
export type MainlineFailure = z.infer<typeof MainlineFailureSchema>;

// What happened to a red verdict's failures, decided once the lands behind it had their own check.
export const MainlineRoutingKindSchema = z.enum([
    // More work landed while this ran; the check that measures it decides, so nobody is sent after a failure it may fix.
    "waiting",
    // A conversation still working touches what failed; nobody else is started until it stops.
    "held",
    // Sent back to the conversation that landed it, which still had the work in mind.
    "original",
    // A fresh conversation was started on it with the failures, the suspects' changes and where to read their sessions.
    "fix-up",
    // Nobody was sent: repairs are switched off, or no conversation could take it. An automation may.
    "reported",
    // Gone at the next check, before anybody was sent.
    "resolved",
    // The sends and fresh attempts a red streak allows are used up; it waits for a person.
    "spent",
    // A person set findings aside as not to be fixed (`findings` names which); what a push left is the owner's to dismiss.
    "dismissed",
]);
export type MainlineRoutingKind = z.infer<typeof MainlineRoutingKindSchema>;

export const MainlineRoutingSchema = z.object({
    kind: MainlineRoutingKindSchema.describe("What became of the failures."),
    conversationId: z
        .string()
        .optional()
        .describe("The conversation working on them (the original or a fresh one), or the one still working that the repair waits for."),
    at: z.number().describe("When that was decided, in milliseconds."),
    detail: z.string().optional().describe("One sentence on why, in the sandbox's words."),
    findings: z
        .array(z.string())
        .optional()
        .describe("The findings it was about, by id, when it was about some of a red's findings rather than the whole red."),
});
export type MainlineRouting = z.infer<typeof MainlineRoutingSchema>;

// The first failures a run names; the whole list stays in its terminal.
export const MAINLINE_FAILURES_KEPT = 30;

export const MainlineRunSchema = z.object({
    project: z.string().describe("Which project, by folder relative to the workspace. Empty is the workspace root."),
    command: z.string().describe("What ran."),
    status: z.enum(["green", "red"]).describe("How it ended."),
    startedAt: z.number().describe("When it started, in milliseconds."),
    at: z.number().describe("When it ended, in milliseconds."),
    lands: z.array(MainlineLandSchema).describe("The lands it answered for, oldest first. Empty for a run no land asked for."),
    failures: z.array(z.string()).describe(`The first failures it named, at most ${MAINLINE_FAILURES_KEPT}.`),
    failureCount: z.number().describe("How many failures it named in all. Zero on a red run that wrote no list."),
    attempt: z.number().describe("How many red runs in a row this is for the project; zero when green."),
    suspects: z
        .array(z.string())
        .optional()
        .describe("The conversations whose lands these failures were laid at, when any could be named."),
    named: z
        .boolean()
        .optional()
        .describe(
            "Whether the failures were laid at the suspects by the paths they changed. False when nobody could be told apart (every land the run covered is a suspect) or nothing new failed in it (none is). Absent on green, and from a daemon that did not say.",
        ),
    units: z
        .array(MainlineFailureSchema)
        .optional()
        .describe("The same first failures, split into a name and the path they failed in. Absent from a daemon that does not split them."),
    routing: MainlineRoutingSchema.optional().describe("What became of a red run's failures. Absent on green, and until it is decided."),
});
export type MainlineRun = z.infer<typeof MainlineRunSchema>;

export const MainlineProjectSchema = z.object({
    project: z.string().describe("Which project, by folder relative to the workspace. Empty is the workspace root."),
    running: z
        .object({
            command: z.string().describe("What is running."),
            startedAt: z.number().describe("When it started, in milliseconds."),
            lands: z.array(MainlineLandSchema).describe("The lands it answers for."),
            on: z.string().optional().describe("The runner it was sent to, on one of your machines. Absent when it runs in this sandbox."),
        })
        .optional()
        .describe("The check running on it now, if any."),
    session: z
        .string()
        .optional()
        .describe("The terminal session its check runs in, running or last, to attach to for the whole log. Absent from a daemon that does not say."),
    queued: z.array(MainlineLandSchema).describe("Lands waiting for the next check, which will measure them together."),
    last: MainlineRunSchema.optional().describe("Its most recent settled check."),
    redSince: z.number().optional().describe("When its checks went red and stayed so, in milliseconds. Absent while green."),
    red: z
        .object({
            since: z.number().describe("When its checks went red and stayed so, in milliseconds."),
            cause: z
                .array(MainlineLandRefSchema)
                .describe("The work this red is laid at, oldest first: the lands its failures were laid at on the latest run of the streak that could name any. Empty when none could be."),
            named: z.boolean().describe("Whether `cause` was narrowed by the paths the lands changed; false when it is every land the run covered."),
            fixer: MainlineRoutingSchema.optional().describe("The latest decision about who has it. Absent until one is made."),
        })
        .optional()
        .describe("The red streak it is in, as the sandbox laid it. Absent while green, and from a daemon that does not lay it."),
});
export type MainlineProject = z.infer<typeof MainlineProjectSchema>;


// WHAT A PUSH LEFT BEHIND. The pre-push hook never refuses (verify-push.mjs, `--advisory`): it measures, reports, and the
// push goes. What it found used to vanish with the terminal it printed to. It now leaves a report in the repository's
// git dir, the daemon files it once the push has actually reached the remote, and what it found is owed, as the
// project's push Red, until a later measurement no longer prints it or somebody dismisses it. Nobody is sent after it:
// acting on it is the owner's call (RED_POLICY).

// ONE FINDING, whatever measured it: a check run's line as the repository's own tooling printed it, named by what
// printed it (`source`, the repository's word: a check's id, `lint`, a hook), with the command that shows it again and
// whether a later measurement can say it is gone. A push's findings are these; a land check's failures and a CI run's
// failed jobs become them too.
export const FindingSchema = z.object({
    id: z.string().describe("Stable across measurements: the same problem found again is the same id."),
    source: z.string().describe("What measured it, in the repository's own words: a check's id, `lint`, a hook."),
    text: z.string().describe("The finding as it was printed."),
    path: z.string().optional().describe("The repository path it is about, when it names one."),
    command: z.string().optional().describe("The command that shows it again."),
    recheckable: z
        .boolean()
        .describe("Whether a later measurement can find it gone. False for one about commits already made, which ends only when dismissed."),
    gate: z
        .enum(["code", "tidy"])
        .optional()
        .describe("For a check's finding: `code` means the tree fails the check whoever caused it; `tidy` means the change measured added this line."),
    commit: z
        .object({ sha: z.string(), subject: z.string() })
        .optional()
        .describe("The newest commit of the change measured that touched the path it names, when it names one."),
});
export type Finding = z.infer<typeof FindingSchema>;

// ONE RED, whatever went red: a land check's project, what a push left in a project, main's CI on a branch. What it owes
// (its findings), who it was laid at and whether that was narrowed, and every decision about it, oldest first. Each
// source answers its own red by its own policy (RED_POLICY); the record is the same.
export const RedSourceSchema = z.enum(["land", "push", "ci"]);
export type RedSource = z.infer<typeof RedSourceSchema>;

// Who answers a red: `route` sends it itself (the land check's router, conversations/land/land-breakage.ts), `owner`
// waits for a person's press (what a push left, conversations/fix/push-fix.ts), `fix-agent` starts the source's own fix
// agent once the red is main's standing word (CI, ci/repair-gate.ts).
export const RED_POLICY = { land: "route", push: "owner", ci: "fix-agent" } as const satisfies Record<RedSource, "route" | "owner" | "fix-agent">;

export const RedSchema = z.object({
    source: RedSourceSchema.describe("What went red."),
    scope: z.string().describe("Where: a project's folder, or a repository and branch."),
    since: z.number().describe("When the red streak began (state/red-streak.ts)."),
    findings: z.array(FindingSchema).default([]).describe("What it owes, as the red's own measurement named it."),
    suspects: z.array(z.string()).default([]).describe("The conversations it was laid at."),
    named: z.boolean().default(false).describe("Whether the paths they changed narrowed it to them."),
    decisions: z.array(MainlineRoutingSchema).default([]).describe("What was decided about it, oldest first."),
});
export type Red = z.infer<typeof RedSchema>;

// ONE PUSH THE HOOK MEASURED, as the record lists it: where it went and what it found that it brought in. What of that is
// still owed is the project's push Red's to say (`findings`), never the push's.
export const MainlinePushSchema = z.object({
    project: z.string().describe("Which project, by folder relative to the workspace. Empty is the workspace root."),
    id: z.string().describe("The report's own id."),
    at: z.number().describe("When the push check ran, in milliseconds."),
    remote: z.string().optional().describe("The remote it was pushed to."),
    branch: z.string().optional().describe("The branch it was pushed to."),
    base: z.string().optional().describe("The commit the pushed range starts from; absent when the remote had nothing to compare with."),
    head: z.string().describe("The commit that was pushed."),
    commits: z.number().describe("How many commits the push carried."),
    findings: z
        .array(FindingSchema)
        .describe("What it found that this push brought in, less what an earlier push had already left open. Empty for a clean push."),
    refused: z
        .boolean()
        .optional()
        .describe("True when the repository's own pre-push hook refused it, so nothing reached the remote and its one finding is what the hook said."),
});
export type MainlinePush = z.infer<typeof MainlinePushSchema>;

export const MainlineStatusSchema = z.object({
    projects: z.array(MainlineProjectSchema).describe("Every project a land has been checked in, or is waiting to be."),
    recent: z.array(MainlineRunSchema).describe("The latest settled checks across every project, newest first."),
    pushed: z
        .array(MainlinePushSchema)
        .optional()
        .describe("The latest pushes the hook measured across every project, newest first, with what each brought in. Absent from a daemon that records none."),
    reds: z
        .array(RedSchema)
        .optional()
        .describe(
            "Every red the main line holds, one record whatever went red: each red project's land check and what pushes left in each project, with what each owes and every decision about it. Absent from a daemon that keeps none.",
        ),
});
export type MainlineStatus = z.infer<typeof MainlineStatusSchema>;

export const MainlinePushDismissSchema = z.object({
    project: z.string().describe("Which project, by folder relative to the workspace."),
    ids: z.array(z.string()).optional().describe("Which findings. Leave it out for every open one in the project."),
    restore: z.boolean().optional().describe("Undo: open the named dismissed findings again."),
});
export type MainlinePushDismiss = z.infer<typeof MainlinePushDismissSchema>;

export const MainlinePushDismissResultSchema = z.object({
    changed: z.number().describe("How many findings changed state."),
});

export const MainlinePushRecheckSchema = z.object({
    project: z.string().describe("Which project, by folder relative to the workspace."),
});

export const MainlinePushRecheckResultSchema = z.object({
    measured: z.boolean().describe("Whether the project could be measured at all; false leaves every finding as it was."),
    resolved: z.number().describe("How many findings the measurement no longer saw."),
    open: z.number().describe("How many are still open."),
});
export type MainlinePushRecheckResult = z.infer<typeof MainlinePushRecheckResultSchema>;

export const MainlinePushFixSchema = z.object({
    project: z.string().describe("Which project's open push findings to hand over, by folder relative to the workspace."),
    pick: AgentRunPickSchema.describe(
        "Which model to open the conversation on, when somebody chose one. Leave it out for the sandbox's own choice.",
    ),
    mode: z
        .enum(["continue", "start-over"])
        .optional()
        .describe(
            "What to do about an attempt already made at these findings: `continue` carries on in it, `start-over` files it away and opens the next attempt. Leave it out for the plain press.",
        ),
});
export type MainlinePushFix = z.infer<typeof MainlinePushFixSchema>;

export const MainlinePushFixResultSchema = z.object({
    conversationId: z.string().describe("The conversation holding the findings. Open it to watch."),
});

// What pushes left in `project`, as the reds name it; undefined while nothing is owed.
export const pushRedOf = (reds: readonly Red[] | undefined, project: string): Red | undefined =>
    reds?.find((red) => red.source === "push" && red.scope === project);

// The conversation id a hand-over of a push red wears (attempt 1), derived from when the red began, so the editor and the
// daemon agree on whether an agent is already on it: pressing again while anything is owed continues the same attempt,
// and a red that begins after everything was handled starts a fresh one. Undefined when nothing is owed.
export const pushFixBase = (red: Pick<Red, "scope" | "since"> | undefined): string | undefined =>
    red === undefined ? undefined : pushFixConversationId(red.scope === "" ? "workspace" : red.scope, `red:${red.since}`);
