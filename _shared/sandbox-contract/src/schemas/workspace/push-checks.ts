// what the pre-push hook let through, and the one record every red keeps, whatever went red
import { z } from "zod";
import { pushFixConversationId } from "../../ids/conversation-ids.js";
import { AgentRunPickSchema } from "../agent.js";

// Nothing checks work inside a conversation or after it lands: CI checks what the owner pushes (ci/main-fixer.ts puts
// one fix agent on main's red), and the pre-push hook measures the push on the way out without ever refusing it
// (verify-push.mjs, `--advisory`). What the hook found used to vanish with the terminal it printed to. It now leaves a
// report in the repository's git dir, the daemon files it once the push has actually reached the remote, and what it
// found is owed, as the project's push Red, until a later measurement no longer prints it or somebody dismisses it.
// Nobody is sent after it: acting on it is the owner's call.

// ONE FINDING, whatever measured it: a check run's line as the repository's own tooling printed it, named by what
// printed it (`source`, the repository's word: a check's id, `lint`, a hook), with the command that shows it again and
// whether a later measurement can say it is gone. A push's findings are these; a CI run's failed jobs become them too.
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
        .describe(
            "For a check's finding: `code` means the tree fails the check whoever caused it; `tidy` means the change measured added this line.",
        ),
    commit: z
        .object({ sha: z.string(), subject: z.string() })
        .optional()
        .describe("The newest commit of the change measured that touched the path it names, when it names one."),
});
export type Finding = z.infer<typeof FindingSchema>;

// What was decided about a red, in the order it was decided.
export const RedDecisionKindSchema = z.enum([
    // A fix agent was put on it: pressed for by a person, or started by the sandbox on main's red CI.
    "fix-up",
    // Nobody was sent: repairs are switched off, or nothing could take it.
    "reported",
    // A later measurement no longer found it (`findings` names which).
    "resolved",
    // The fix agent had its turns, or stopped without a fix: it waits for a person.
    "spent",
    // A person set findings aside as not to be fixed (`findings` names which).
    "dismissed",
]);
export type RedDecisionKind = z.infer<typeof RedDecisionKindSchema>;

export const RedDecisionSchema = z.object({
    kind: RedDecisionKindSchema.describe("What was decided."),
    conversationId: z.string().optional().describe("The conversation working on it, when one is."),
    at: z.number().describe("When that was decided, in milliseconds."),
    detail: z.string().optional().describe("One sentence on why, in the sandbox's words."),
    findings: z
        .array(z.string())
        .optional()
        .describe("The findings it was about, by id, when it was about some of a red's findings rather than the whole red."),
});
export type RedDecision = z.infer<typeof RedDecisionSchema>;

// ONE RED, whatever went red: what a push left in a project, main's CI on a branch. What it owes (its findings) and every
// decision about it, oldest first. A push's red waits for the owner's press (conversations/fix/push-fix.ts); main's CI
// red gets one fix agent by itself (ci/main-fixer.ts). The record is the same.
export const RedSourceSchema = z.enum(["push", "ci"]);
export type RedSource = z.infer<typeof RedSourceSchema>;

export const RedSchema = z.object({
    source: RedSourceSchema.describe("What went red."),
    scope: z.string().describe("Where: a project's folder, or a repository and branch."),
    since: z.number().describe("When the red streak began (state/red-streak.ts)."),
    findings: z.array(FindingSchema).default([]).describe("What it owes, as the red's own measurement named it."),
    decisions: z.array(RedDecisionSchema).default([]).describe("What was decided about it, oldest first."),
});
export type Red = z.infer<typeof RedSchema>;

// ONE PUSH THE HOOK MEASURED, as the record lists it: where it went and what it found that it brought in. What of that is
// still owed is the project's push Red's to say (`findings`), never the push's.
export const PushCheckSchema = z.object({
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
        .describe(
            "True when the repository's own pre-push hook refused it, so nothing reached the remote and its one finding is what the hook said.",
        ),
});
export type PushCheck = z.infer<typeof PushCheckSchema>;

export const PushChecksSchema = z.object({
    pushed: z.array(PushCheckSchema).describe("The latest pushes the hook measured across every project, newest first, with what each brought in."),
    reds: z.array(RedSchema).describe("What pushes left in each project and is still owed, one push Red per project, with every decision about it."),
});
export type PushChecks = z.infer<typeof PushChecksSchema>;

export const PushDismissSchema = z.object({
    project: z.string().describe("Which project, by folder relative to the workspace."),
    ids: z.array(z.string()).optional().describe("Which findings. Leave it out for every open one in the project."),
    restore: z.boolean().optional().describe("Undo: open the named dismissed findings again."),
});
export type PushDismiss = z.infer<typeof PushDismissSchema>;

export const PushDismissResultSchema = z.object({
    changed: z.number().describe("How many findings changed state."),
});

export const PushRecheckSchema = z.object({
    project: z.string().describe("Which project, by folder relative to the workspace."),
});

export const PushRecheckResultSchema = z.object({
    measured: z.boolean().describe("Whether the project could be measured at all; false leaves every finding as it was."),
    resolved: z.number().describe("How many findings the measurement no longer saw."),
    open: z.number().describe("How many are still open."),
});
export type PushRecheckResult = z.infer<typeof PushRecheckResultSchema>;

export const PushFixSchema = z.object({
    project: z.string().describe("Which project's open push findings to hand over, by folder relative to the workspace."),
    pick: AgentRunPickSchema.describe("Which model to open the conversation on, when somebody chose one. Leave it out for the sandbox's own choice."),
    mode: z
        .enum(["continue", "start-over"])
        .optional()
        .describe(
            "What to do about an attempt already made at these findings: `continue` carries on in it, `start-over` files it away and opens the next attempt. Leave it out for the plain press.",
        ),
});
export type PushFix = z.infer<typeof PushFixSchema>;

export const PushFixResultSchema = z.object({
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
