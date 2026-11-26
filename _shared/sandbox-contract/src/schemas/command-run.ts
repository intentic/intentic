import { z } from "zod";

// One shape for any command the daemon runs on a click with a verdict and a quotable tail (the push via PushRunSchema in
// schemas/git/git.ts, which runs the repository's own pre-push hook), so the fields the browser reads (terminal, tail,
// kill vs timeout) have one definition.
// idle: nothing has run yet, or the last run was cleared
// running: live; its output is the terminal's, not this object's
// passed: exited 0
// failed: exited non-zero, or killed by its ceiling (`timedOut`)
// error: not spawnable at all; not fixable, since nothing is wrong with the code
// cancelled: the user stopped it
export const CommandRunStatusSchema = z.enum(["idle", "running", "passed", "failed", "error", "cancelled"]);
export type CommandRunStatus = z.infer<typeof CommandRunStatusSchema>;
export const CommandRunSchema = z.object({
    status: CommandRunStatusSchema.describe(
        "Where the run is. Failed and error are deliberately different: failed means the code is wrong, error means the command could not be run at all, and calling the second one a test failure would send an agent hunting a bug that is not there.",
    ),
    // Echoed rather than read from settings, so a result seen after the setting changed still says what produced it.
    command: z
        .string()
        .describe(
            "What actually ran, echoed here rather than read back from the settings, so a result looked at after the setting changed still says what produced it.",
        ),
    startedAt: z.number().optional().describe("When it began, in milliseconds."),
    finishedAt: z.number().optional().describe("When it ended, in milliseconds."),
    exitCode: z.number().optional().describe("How the command exited."),
    timedOut: z.boolean().optional().describe("It was killed for taking too long rather than finishing."),
    // The tmux session to open, since watching a run is the terminal panel's job, not this object's; absent where the
    // sandbox has no tmux wrapper.
    session: z
        .string()
        .optional()
        .describe(
            "The terminal it runs in, which is where to watch it. Absent where the sandbox has no terminals, in which case there is nothing to attach to.",
        ),
    // Tail-capped plain text, colour codes and redrawn progress lines stripped, so a fix prompt quotes a verdict, not
    // terminal litter; empty while running or for a killed run.
    output: z
        .string()
        .describe(
            "The end of what it printed, as plain text with the colour codes and redrawn progress lines resolved away. The end rather than the beginning, because a suite's verdict is at the end. Empty while it runs, and for one that was killed.",
        ),
});
export type CommandRun = z.infer<typeof CommandRunSchema>;
