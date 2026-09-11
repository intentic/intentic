// repo-checks: what a REPOSITORY says should be run on its own code, declared in the repository, at
// `<repo>/.intentic/checks.json`.
//
// The line between this file and the sandbox's own settings is authority, not subject matter: a repository may declare
// WHAT to run, because the command belongs beside the scripts it names and travels with the checkout; only the sandbox
// owner decides what happens when it fails (whether work lands, whether a push goes), and that stays in settings.json.
// Nothing declared here runs until the owner adopts it for that repository (settings `adoptedChecks`), the same rule
// git keeps for hooks, which are never cloned.
import { z } from "zod";

// Named for the occasion as a repository would say it, not for the daemon's wire moment: `turn` is `turn.ending` and
// `push` is `push.starting` (rules/repo-checks.ts maps them). Two, because these are the two occasions whose command a
// repository actually owns; a verdict moment has nothing here to express.
export const RepoCheckMomentSchema = z.enum(["turn", "push"]);
export type RepoCheckMoment = z.infer<typeof RepoCheckMomentSchema>;

export const RepoCheckSchema = z.object({
    when: RepoCheckMomentSchema.describe("When to run it: `turn` before the assistant finishes, `push` before code leaves the machine."),
    run: z.string().min(1).max(500).describe("The command, run in this repository's own directory, so it reads as it would in a terminal there."),
    label: z.string().min(1).max(80).optional().describe("What to call it on screen. Absent names it after the command."),
    // Same ceiling as a rule's own command; past it the process group is killed and the run is a failure, never a
    // silent pass.
    timeoutMs: z.number().min(60_000).max(3_600_000).optional().describe("How long it may take before it is killed and counted as failed."),
    // Repo-relative, as anybody reading this file would write them; the daemon prefixes the repo id before matching,
    // since a rule's globs are workspace-relative.
    paths: z
        .array(z.string().min(1))
        .max(20)
        .optional()
        .describe("Only run it when the change touches these paths, written relative to this repository. Absent runs it on every change here."),
});
export type RepoCheck = z.infer<typeof RepoCheckSchema>;

// The file itself. One key, so a second concern can be added later without breaking a file anyone has written.
export const RepoChecksFileSchema = z.object({ checks: z.array(RepoCheckSchema).max(10).default([]) });
export type RepoChecksFile = z.infer<typeof RepoChecksFileSchema>;

// One repository, as a screen reads it: what it declares, and where that stands with the owner.
export const RepoChecksSummarySchema = z.object({
    repo: z.string().describe('Which repository, by its workspace id ("root" is the workspace itself).'),
    path: z.string().describe("Where the declaration lives, relative to the workspace, whether or not the file exists yet."),
    checks: z.array(RepoCheckSchema).describe("What it declares, in the order the file lists them."),
    adopted: z
        .boolean()
        .describe("Whether these are running. False means declared and inert: nothing a repository writes runs until the owner switches it on."),
    changed: z
        .boolean()
        .describe(
            "Whether the declaration changed since it was adopted, which holds it until the owner looks again. True only for a repository that was adopted before.",
        ),
    error: z.string().optional().describe("Why the file could not be read, when it exists but does not parse. The checks list is empty in that case."),
});
export type RepoChecksSummary = z.infer<typeof RepoChecksSummarySchema>;
export const RepoChecksListSchema = z.object({
    repos: z.array(RepoChecksSummarySchema).describe("Every repository that declares checks, plus any the owner has adopted before, sorted by id."),
});
export type RepoChecksList = z.infer<typeof RepoChecksListSchema>;
export const RepoChecksAdoptSchema = z.object({
    repo: z.string().min(1).describe("Which repository's declaration to switch."),
    on: z
        .boolean()
        .describe("On adopts what it declares as it stands now; off stops running it. Adopting again is how a changed declaration is accepted."),
});
export type RepoChecksAdopt = z.infer<typeof RepoChecksAdoptSchema>;
