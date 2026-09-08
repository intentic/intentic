// panels: per-repository dev servers + the content facts extensions detect on
import { z } from "zod";
// Every discovered repo under /work is one row: runnable-panel status (a `dev` script the daemon runs and auto-assigns
// a port, proxied at preview-<panelKey>-<sandboxId>.<zone>) plus content facts extensions run detect() over, computed
// daemon-side so the browser never scans /work.

// Between click and first byte; `exited` matters most, since without it "Preparing the preview…" would never end.
// Absent once something serves.
export const PanelLaunchSchema = z.enum(["launching", "installing", "starting", "exited"]);
export type PanelLaunch = z.infer<typeof PanelLaunchSchema>;

export const PanelSummarySchema = z.object({
    // Root-relative dir under /work; slashes become `--` in the preview subdomain label.
    repo: z.string().describe("Which repository."),
    // A package.json `dev` script at operator/ or the repo root.
    hasPanel: z.boolean().describe("Whether it has anything runnable at all."),
    running: z.boolean().describe("Whether the sandbox has it running."),
    // True for a repo with nothing runnable — nothing to install for.
    installed: z
        .boolean()
        .describe("Whether its dependencies are installed, which is what decides whether a start takes seconds or an install first."),
    launch: PanelLaunchSchema.optional().describe(
        "Where a start the sandbox is running has got to: its shell coming up, installing, its dev command running with nothing listening yet, or exited back to a prompt. Absent when nothing is starting and once it serves.",
    ),
    healthy: z
        .boolean()
        .describe(
            "Whether anything it owns is actually answering. A different question: a server still installing is running and not yet healthy, and one somebody started by hand is healthy without the sandbox running it.",
        ),
    port: z
        .number()
        .optional()
        .describe(
            "The port the sandbox told it to use. What it actually bound is below, and for a repository that pins its own ports those are different numbers.",
        ),
    // One entry per app for a monorepo whose `dev` fans out across packages (`dir` is what tells them apart); `session`
    // absent means nothing in the sandbox owns it, worth designing for.
    servers: z
        .array(
            z.object({
                port: z.number().describe("The port it is listening on, which is what forwarding it takes."),
                url: z.string().describe("Where it answers, with the right scheme: a server on its own certificate is served over https."),
                dir: z
                    .string()
                    .optional()
                    .describe(
                        "Which part of the repository it belongs to, which for a repository whose dev command fans out is the only thing telling them apart.",
                    ),
                session: z
                    .string()
                    .optional()
                    .describe(
                        "The terminal it runs in: the sandbox's when it started it, yours when you did, and absent when nothing here owns it, which is the case worth designing for.",
                    ),
            }),
        )
        .describe("Every server this repository is really serving, found by looking at what is listening. Empty when nothing answers."),
    // `https://preview-<repo>-<sandboxId>.<zone>`; absent whenever no single hostname could stand for what's running
    // (nothing up, still starting, several servers).
    previewUrl: z
        .string()
        .optional()
        .describe("Where to open it from outside, present only while that address really serves it. Absent on a sandbox with no outside address."),
    role: z
        .enum(["intent", "desired-state", "app"])
        .optional()
        .describe("Which of the workspace's three fixed roles this repository fills. Absent for one that was simply cloned in."),
    // Detected from specific files:
    // deployConfig: deploy.config.ts.
    // desiredState: desired-state.json (present after the first resolve).
    // directoryUi: .intentic/ui/index.html.
    // monorepo: pnpm-workspace.yaml + turbo.json.
    // vitest: a root vitest.config.ts, or "vitest" in the manifest/workspace catalog.
    // userStories: docs/user-stories.
    // docs: docs/architecture.
    deployConfig: z.boolean().describe("It declares infrastructure."),
    desiredState: z.boolean().describe("That declaration has been resolved at least once."),
    directoryUi: z.boolean().describe("It carries a small interface of its own."),
    monorepo: z.boolean().describe("It holds several packages."),
    vitest: z.boolean().describe("It has tests that can be run."),
    userStories: z
        .boolean()
        .describe("It carries stories an agent could test the running app against. The one fact here that says nothing about the language."),
    docs: z.boolean().describe("It carries generated architecture documentation."),
});
export type PanelSummary = z.infer<typeof PanelSummarySchema>;
export const PanelsListSchema = z.object({
    panels: z
        .array(PanelSummarySchema)
        .describe("One entry per repository, worked out in a single pass so nothing has to walk the workspace file by file."),
});
export type PanelsList = z.infer<typeof PanelsListSchema>;
// The {repo} path param on the start/stop/terminals routes (a bare string: unknown repo is a handler NOT_FOUND).
export const PanelRepoParamSchema = z.object({ repo: z.string().describe("Which repository.") });
