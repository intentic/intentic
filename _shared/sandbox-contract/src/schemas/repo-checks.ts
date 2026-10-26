// Checks a repository declares; sandbox settings decide whether the owner adopts them.
import { STATE_DIR } from "@intentic/constants";
import { z } from "zod";

// Where a repository declares them, under the same `.intentic/` folder a directory already uses for its own UI. One
// spelling for the daemon that reads it, the screen that names it and the demo that mimics it.
export const REPO_CHECKS_FILE = `${STATE_DIR}/checks.json`;

// Named for the occasion as a repository would say it: `edit` is `file.edited` and `turn` is `turn.ending`
// (rules/repo-checks.ts maps them). `edit` runs on one file (`{file}`) and its output rides back in the edit's own
// response, so a command declared there is paid per edit and has to take the file. `turn` runs once when an isolated
// turn is about to stop, on the whole tree, and what it prints when it fails is said back to the model once, which may
// fix it or say why not. `land` is retired: nothing runs after work lands any more (CI checks what the owner pushes), and
// a declaration naming it still reads but runs nothing. No check refuses a land, a commit or a push.
export const RepoCheckMomentSchema = z.enum(["edit", "turn", "land"]);
export type RepoCheckMoment = z.infer<typeof RepoCheckMomentSchema>;

export const RepoCheckSchema = z.object({
    when: RepoCheckMomentSchema.describe(
        "When to run it: `edit` on each file as it is written (`{file}` is its path); `turn` once when an isolated turn is about to stop, for at most three minutes, with what it prints on failure said back to the model once. Neither holds or refuses anything. `land` is retired and runs nothing, since CI checks what is pushed.",
    ),
    run: z.string().min(1).max(500).describe("The command, run in this repository's own directory, so it reads as it would in a terminal there."),
    label: z.string().min(1).max(80).optional().describe("What to call it on screen. Absent names it after the command."),
    // Same ceiling as a rule's own command; past it the process group is killed and the run is a failure.
    timeoutMs: z.number().min(60_000).max(3_600_000).optional().describe("How long it may take before it is killed and counted as failed."),
    // Repo-relative; the daemon prefixes the repo id before matching, since a rule's globs are workspace-relative.
    paths: z
        .array(z.string().min(1))
        .max(20)
        .optional()
        .describe("Only run it when the change touches these paths, written relative to this repository. Absent runs it on every change here."),
});
export type RepoCheck = z.infer<typeof RepoCheckSchema>;

// The file itself. One key, so a second concern can be added later without breaking a file anyone has written.
export const RepoChecksFileSchema = z.object({
    checks: z
        .array(RepoCheckSchema)
        .max(10)
        .default([]),
});
export type RepoChecksFile = z.infer<typeof RepoChecksFileSchema>;

// One repository, as a screen reads it: what it declares, and where that stands with the owner.
export const RepoChecksSummarySchema = z.object({
    repo: z.string().describe('Which repository, by its workspace id ("root" is the workspace itself).'),
    path: z.string().describe("Where the declaration lives, relative to the workspace, whether or not the file exists yet."),
    checks: z.array(RepoCheckSchema).describe("What it declares, in the order the file lists them."),
    fired: z
        .array(z.number().nullable())
        .describe(
            "When each declared check last reported something, in the file's order, as epoch milliseconds; null for one that never has, or for a retired one, which runs nothing.",
        ),
    adopted: z
        .boolean()
        .describe("Whether these are running. False means declared and inert: nothing a repository writes runs until the owner switches it on."),
    changed: z
        .boolean()
        .describe(
            "Whether the declaration gained or rewrote a check since it was adopted. What changed waits until the owner looks again; the checks the owner already agreed to, word for word, keep running (`held` says which is which). True only for a repository that was adopted before.",
        ),
    held: z
        .array(z.boolean())
        .optional()
        .describe(
            "For a changed declaration, which of its checks wait for the owner, in the file's order: true for one that is new or rewritten since they agreed, false for one still running as agreed, or retired. Absent when nothing changed, and from a sandbox that holds a changed declaration whole.",
        ),
    error: z.string().optional().describe("Why the file could not be read, when it exists but does not parse. The checks list is empty in that case."),
});
export type RepoChecksSummary = z.infer<typeof RepoChecksSummarySchema>;
export const RepoChecksListSchema = z.object({
    repos: z.array(RepoChecksSummarySchema).describe("Every repository that declares checks, in id order."),
});
export type RepoChecksList = z.infer<typeof RepoChecksListSchema>;
export const RepoChecksAdoptSchema = z.object({
    repo: z.string().min(1).describe("Which repository's declaration to switch."),
    on: z
        .boolean()
        .describe("On adopts what it declares as it stands now; off stops running it. Adopting again is how a changed declaration is accepted."),
});
export type RepoChecksAdopt = z.infer<typeof RepoChecksAdoptSchema>;
