// panels: per-repository dev servers + the content facts extensions detect on
import { z } from "zod";
// Every discovered git repo under /work is one list row: its runnable-panel runtime status (a `dev` script at
// operator/ or the repo root; the daemon runs it, auto-assigns a free port, and the preview proxy routes
// preview-<panelKey>-<sandboxId>.<zone> to it) PLUS content facts, evidence the web app's extensions run their
// detect() over, computed daemon-side in one pass so the browser never scans /work file-by-file.

/* WHERE A START THE SANDBOX IS RUNNING HAS GOT TO, between the click and the first byte served. The process
 * manager watches the pane's foreground command every couple of seconds (processes/managed-processes.ts), and
 * these four words are what that sampling can honestly say: the shell is still coming up; the install that
 * runs first when node_modules is missing is still going; the dev command is running but nothing listens yet;
 * or the command has already exited back to a prompt, which is the one a person needs told at once, because
 * the "Preparing the preview…" it would otherwise sit behind never ends. Absent once the preview proxy has
 * something to serve, and absent for anything the sandbox is not starting. */
export const PanelLaunchSchema = z.enum(["launching", "installing", "starting", "exited"]);
export type PanelLaunch = z.infer<typeof PanelLaunchSchema>;

export const PanelSummarySchema = z.object({
    // The repo id: its root-relative dir under /work (slashes become `--` in the preview subdomain label).
    repo: z.string().describe("Which repository."),
    // Whether the repo ships a runnable dev server (a package.json `dev` script at operator/ or the root).
    hasPanel: z.boolean().describe("Whether it has anything runnable at all."),
    running: z.boolean().describe("Whether the sandbox has it running."),
    /* Whether its dependencies are on disk, a node_modules at the directory Start runs in. What decides what a
     * Start COSTS: seconds when true, an install first when false, and the Start screen's copy says which
     * instead of promising "a few minutes" over a tree that is already installed (the starter site's is: the
     * image bakes it). True for a repo with nothing runnable, which has nothing to install for. */
    installed: z
        .boolean()
        .describe("Whether its dependencies are installed, which is what decides whether a start takes seconds or an install first."),
    launch: PanelLaunchSchema.optional().describe(
        "Where a start the sandbox is running has got to: its shell coming up, installing, its dev command running with nothing listening yet, or exited back to a prompt. Absent when nothing is starting and once it serves.",
    ),
    // Whether anything this repo owns is answering, see `servers`. Not the same question as `running`: a panel
    // whose install is still going is running and not yet healthy, and a dev server someone started in their own
    // terminal is healthy without the daemon running it.
    healthy: z
        .boolean()
        .describe(
            "Whether anything it owns is actually answering. A different question: a server still installing is running and not yet healthy, and one somebody started by hand is healthy without the sandbox running it.",
        ),
    // The dev server's OS-assigned port; absent when not running. What the daemon TOLD the repo to bind (the
    // preview proxy forwards it), `servers` is what the repo actually bound, which for a repo that pins its own
    // ports is a different number entirely.
    port: z
        .number()
        .optional()
        .describe(
            "The port the sandbox told it to use. What it actually bound is below, and for a repository that pins its own ports those are different numbers.",
        ),
    // Every dev server the repo is really serving, discovered from the sandbox's listening sockets and probed for
    // the scheme each speaks (a Vite on a committed dev cert serves https). One entry for the ordinary repo; a
    // monorepo whose `dev` fans out across packages has one per app, which is why `dir` is here, `_editor/web` vs
    // `_site/site` is the only thing that tells them apart. Empty when nothing answers.
    //
    // `session` is the terminal it is running in: the panel's own when the daemon started it, the user's when
    // they ran it by hand, and ABSENT when nothing in the sandbox owns it. That last case is the one worth
    // designing for, the repo is plainly answering, and no terminal here can show, stop or restart it.
    servers: z
        .array(
            z.object({
                // The port itself, not just the URL it appears in: forwarding one is how a repo answering on
                // several ports becomes previewable at all, and that call takes a number.
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
    /* https://preview-<repo>-<sandboxId>.<zone>, and ONLY where that address actually serves this repo: absent
     * on a sandbox with no zone or connect token (loopback/tests), and absent whenever the preview proxy has
     * nothing to route it to — nothing running, still starting, or (the ordinary monorepo) several dev servers
     * on ports of their own, none of which one hostname can stand for. Present ⇒ safe to open or frame, which
     * is what stops a surface from showing a 502 as if it were the app. */
    previewUrl: z
        .string()
        .optional()
        .describe("Where to open it from outside, present only while that address really serves it. Absent on a sandbox with no outside address."),
    // The workspace role this repo dir occupies (the three fixed dirs); absent for extra clones.
    role: z
        .enum(["intent", "desired-state", "app"])
        .optional()
        .describe("Which of the workspace's three fixed roles this repository fills. Absent for one that was simply cloned in."),
    // Content facts: deploy.config.ts (the intent ledger's day-one marker), desired-state.json (present after
    // the first resolve), .intentic/ui/index.html (a sandboxed directory UI), pnpm-workspace.yaml +
    // turbo.json (a pnpm+turbo monorepo), vitest evidence (a root vitest.config.ts, or "vitest" in the
    // root manifest / workspace catalog), docs/user-stories (a directory of stories an agent can test
    // against the running app, the one fact here that says nothing about the repo's language), and
    // docs/architecture (the repo carries generated architecture documentation).
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
