import { STATE_DIR } from "@intentic/constants";
import { z } from "zod";
import { ArtifactNameSchema } from "./device-artifacts.js";

// <repo>/.intentic/run.json declares what a repository can run, and where: in the sandbox, on the owner's own computers, or
// either. One file behind the editor's Run dialog (the sandbox beside every computer, one choice of where), the Browsers
// view's Start and `devices run <target>`.
// - In the sandbox: `command`, run from the repository's root as Start runs it, handed the PORT its preview address is
//   routed to and the sandbox desktop's DISPLAY. A repository whose first such target exists runs it on Start
//   (_sandbox/sandbox/src/panels/run-plan.ts).
// - On a computer: `artifact`. Each run builds in the sandbox, pushes the artifact, reaches the declared device ports and
//   starts the program via app_start.
// Declaring one never starts it automatically.

export const RUN_TARGETS_FILE = `${STATE_DIR}/run.json`;

// The longest a target may ask a stop to wait before forcing it (the machine's app_start takes the same bound).
export const MAX_STOP_GRACE_SECONDS = 600;

// The files under the workspace root's `.intentic/` that are the project's rather than the sandbox's, which no store of
// the daemon's owns: a project kept at the workspace root declares its targets there, as any repository does in its own.
// The root repo tracks them (VERSIONED_STATE_PATHS in state/workspace-state.ts), so an agent's edit lands like code.
export const ROOT_PROJECT_PATHS: readonly string[] = [RUN_TARGETS_FILE];

const RepoPathSchema = z
    .string()
    .min(1)
    .max(500)
    .refine((path) => !path.startsWith("/") && !path.split(/[\\/]/).includes(".."), "a path inside the repository, relative to its root");
const BundleNameSchema = z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,199}(\/[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,199})*$/, "a relative name, folders by /");

// What an app inside a repository may be called (workspace-repos.ts AppParamSchema), kept short enough for its preview
// hostname.
const SANDBOX_TARGET_NAME = /^[a-z][a-z0-9-]{0,39}$/;

export const RunTargetSchema = z
    .object({
        // What `devices run <name>` and the button call it.
        name: ArtifactNameSchema,
        description: z.string().max(300).optional(),
        // What runs it in the sandbox, from the repository's root: a dev server listens on $PORT, a program with a window
        // opens it on the sandbox desktop. Absent means it runs only on a computer.
        command: z.string().min(1).max(4000).optional(),
        // The computer it runs on unless one is named at the run; the device's name as its tools are mounted.
        device: z.string().min(1).max(100).optional(),
        // A shell command run from the repository's root, in the sandbox, before every run; absent means the artifact
        // is already there.
        build: z.string().min(1).max(4000).optional(),
        // What is carried to a computer: one file or one folder, or a set of files and folders gathered into one folder
        // under names of their own (an .exe beside the sidecars, DLLs and resource folders it looks for next to itself).
        // Absent means it runs only in the sandbox.
        artifact: z.union([RepoPathSchema, z.record(BundleNameSchema, RepoPathSchema)]).optional(),
        // Which file to start when the artifact is a folder or a set; a lone file is started as itself.
        program: BundleNameSchema.optional(),
        args: z.array(z.string().max(4000)).max(100).default([]),
        env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(4000)).default({}),
        // Run it inside Windows Sandbox, a throwaway VM that sees the build read-only and nothing else of the machine.
        isolated: z.boolean().default(false),
        // The device's own loopback ports the sandbox needs to reach while it runs (its local API, a dev server), each
        // opened at the same port in the sandbox.
        reach: z.array(z.int().min(1).max(65535)).max(16).default([]),
        // On a computer: how long a stop waits, once the program was asked to close (WM_CLOSE to its window, a
        // Ctrl-Break to a console program, SIGTERM elsewhere), before forcing it. Absent is the computer's own five
        // seconds; a program that saves on exit on a machine short of memory (a game server writing its world) can
        // need far more.
        stopGraceSeconds: z.int().min(1).max(MAX_STOP_GRACE_SECONDS).optional(),
    })
    .strict()
    .refine(
        (target) => target.command !== undefined || target.artifact !== undefined,
        `a target needs a "command" (to run in the sandbox) or an "artifact" (to run on your computers), or both`,
    )
    // A sandbox run is served at preview-<repo>--<name>-<sandboxId>.<zone>, so its name is a piece of a DNS label.
    .refine(
        (target) => target.command === undefined || SANDBOX_TARGET_NAME.test(target.name),
        `a target that runs in the sandbox names its preview address: lowercase letters, digits and dashes, starting with a letter`,
    );
export type RunTarget = z.infer<typeof RunTargetSchema>;

// Where a target can run: in the sandbox when it has a command, on a computer when it carries an artifact.
export const runsInSandbox = (target: Pick<RunTarget, "command">): boolean => target.command !== undefined;
export const runsOnComputers = (target: Pick<RunTarget, "artifact">): boolean => target.artifact !== undefined;

export const RunTargetsFileSchema = z
    .object({
        targets: z
            .array(RunTargetSchema)
            .min(1)
            .max(50)
            .refine((targets) => new Set(targets.map((target) => target.name)).size === targets.length, "two targets share a name"),
    })
    .strict();

// One repository's file as the editor lists it: its targets, or what is wrong with the file.
export const RepoRunTargetsSchema = z.object({
    repo: z.string(),
    path: z.string(),
    targets: z.array(RunTargetSchema),
    error: z.string().optional(),
});
export type RepoRunTargets = z.infer<typeof RepoRunTargetsSchema>;

export const RunTargetsListSchema = z.object({
    repos: z.array(RepoRunTargetsSchema),
    // The owner's computers: whether each is connected, whether its agent is new enough to take a program, and whether
    // its card's "Run programs this sandbox sends" switch is on. A run needs all three.
    devices: z.array(z.object({ id: z.string(), online: z.boolean(), programs: z.boolean(), allowed: z.boolean() })),
});
export type RunTargetsList = z.infer<typeof RunTargetsListSchema>;

export const RunStartSchema = z.object({
    repo: z.string().min(1),
    target: ArtifactNameSchema,
    device: z.string().min(1).max(100),
});
export type RunStart = z.infer<typeof RunStartSchema>;

// The terminal session the run is in, for the editor to open.
export const RunStartedSchema = z.object({ session: z.string() });

// A PROGRAM RUNNING ON ONE OF THE OWNER'S COMPUTERS, as the computer itself reports it (its app_status), whoever started
// it: the Run dialog, `devices run` or `devices start` in a shell, or an agent's app_start. `name` is the target's name
// for a run started from a run-targets file, which is how the dialog finds a target's run.
export const DeviceRunStateSchema = z.enum(["running", "ended", "unknown"]);
export type DeviceRunState = z.infer<typeof DeviceRunStateSchema>;

// WHAT A RUN WAS BUILT FROM: the repository's commit and how much of its tree was uncommitted when `devices run` began
// its build (in the owner's tree that is mostly landed work, since a land leaves its changes uncommitted), and whether
// the tree moved while it compiled. With `landsSince` on the run, the Run dialog says whether the program on the
// computer is the newest work or a restart would bring more.
export const RunBuiltFromSchema = z.object({
    // The full sha of HEAD when the build began.
    commit: z.string().min(1).max(64),
    // Paths with uncommitted changes then (`git status`): 0 is a clean tree.
    changed: z.int().nonnegative(),
    // When the build began.
    at: z.string(),
    // The tree changed while it compiled (a land that was already writing, the owner's own edits): it may mix versions.
    movedDuringBuild: z.boolean().optional(),
});
export type RunBuiltFrom = z.infer<typeof RunBuiltFromSchema>;

export const DeviceRunSchema = z.object({
    device: z.string(),
    // The run id the computer's app_status, app_logs and app_stop take.
    id: z.string(),
    name: z.string(),
    // `unknown`: its process is alive but the computer cannot tell whether it is still this run, so it will not stop it.
    state: DeviceRunStateSchema,
    // The computer's own words for it: "running, pid 4120", "exited with code 101", "stopped by the Run dialog's Stop".
    said: z.string(),
    // How it ended, when it exited by itself with a code.
    exitCode: z.int().optional(),
    startedAt: z.string(),
    endedAt: z.string().optional(),
    // The repository whose run-targets file it was started from, when this sandbox started it so since its last restart.
    repo: z.string().optional(),
    // The computer's ports the sandbox reaches for it (the target's `reach`), open while it runs, closed when it stops.
    ports: z.array(z.int().min(1).max(65535)),
    // Who started it, when this sandbox did since its last restart: "the Run dialog", "conversation <id>", "a terminal".
    startedBy: z.string().optional(),
    // What its build was made from, when `devices run` built it (RunBuiltFromSchema).
    builtFrom: RunBuiltFromSchema.optional(),
    // Lands into its repository since its build began, as far as this sandbox has seen since it came up.
    landsSince: z.int().nonnegative().optional(),
});
export type DeviceRun = z.infer<typeof DeviceRunSchema>;

export const DeviceRunsQuerySchema = z.object({ device: z.string().min(1).max(100) });
// A run's terminal still open (building, pushing, or following its program): the job session the editor reopens.
export const RunTerminalSchema = z.object({ repo: z.string(), target: z.string(), session: z.string() });
export type RunTerminal = z.infer<typeof RunTerminalSchema>;

export const DeviceRunsSchema = z.object({
    runs: z.array(DeviceRunSchema),
    // The Run dialog's terminals for this computer that are still open.
    terminals: z.array(RunTerminalSchema),
    // Why the computer's list could not be read: `runs` is then empty because nothing is known, not because nothing runs.
    error: z.string().optional(),
});

// Follow a target's program already running on one computer in a terminal (`devices attach`), as its run's own terminal
// does: the one the Run dialog's Terminal opens once that terminal is gone.
export const RunAttachSchema = RunStartSchema.extend({ id: z.string().min(1).max(200) });
export type RunAttach = z.infer<typeof RunAttachSchema>;

// Stop a target's run on one computer: the terminal it is being built or followed in, and the program itself (by `id`,
// else every running program the target's name is on).
export const RunStopSchema = RunStartSchema.extend({ id: z.string().min(1).max(200).optional() });
export type RunStop = z.input<typeof RunStopSchema>;
export const RunStoppedSchema = z.object({
    // The computer's own sentence for each program stopped; empty when nothing of the target's was running there.
    stopped: z.array(z.object({ id: z.string(), text: z.string() })),
});

// A run's output, from its log on the computer. Without `since`, its last `lines`; with `since` (the `total` an earlier
// read answered), only what it printed after that read.
export const RunOutputQuerySchema = z.object({
    device: z.string().min(1).max(100),
    id: z.string().min(1).max(200),
    // Coerced: a GET's input arrives as query text.
    since: z.coerce.number().int().nonnegative().optional(),
    lines: z.coerce.number().int().positive().max(2000).default(200),
});
export type RunOutputQuery = z.input<typeof RunOutputQuerySchema>;
export const RunOutputSchema = z.object({
    run: DeviceRunSchema.optional(),
    // The log's size in bytes when read: the `since` of the next read.
    total: z.int().nonnegative(),
    lines: z.array(z.string()),
});
export type RunOutput = z.infer<typeof RunOutputSchema>;
