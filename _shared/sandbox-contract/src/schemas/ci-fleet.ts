import { z } from "zod";

// THE SELF-HOSTED CI RUNNERS ON ONE OF THE OWNER'S COMPUTERS: GitHub Actions runner instances registered as systemd
// units (`actions.runner.*.service`, as the runner's own svc.sh names them), read and driven over the connection the
// machine's agent already holds open. The agent runs as the person; what needs root (starting a system unit, emptying a
// job's leftovers that a job container wrote as root, holding the test-memory pool's slots) is done by the machine's
// fleet service, `intentic-ci-fleet.service`, the same agent binary from a root-owned copy, which the agent asks over a
// local socket (_devices/machine src/ci-fleet/). Without that service a computer still lists its runners, read-only.
// The daemon relays (_sandbox/sandbox hosts/ci-fleet/device-ci-fleet.ts); the Pipelines view draws the Runners section.

// A runner's name as GitHub accepts one and as the runner's own config.sh writes it into the unit's name: letters,
// digits, dot, dash and underscore. Also the folder the fleet service registers a new one in, so one plain segment.
export const CiRunnerNameSchema = z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "letters, digits, dot, dash and underscore, starting with a letter or digit, at most 64");
export type CiRunnerName = z.infer<typeof CiRunnerNameSchema>;

// systemd's own ActiveState words, plus `unknown` for one a newer systemd says that this list does not know, and
// `not-installed` for a runner folder whose `.service` names a unit systemd no longer has: configured, never started
// again (z440's four on 2026-11-24, their units gone since 2026-11-09 while the folders stayed). Only re-registering,
// or the runner's own `svc.sh install`, brings one back; the keeper cannot.
export const CiRunnerStateSchema = z.enum(["active", "activating", "deactivating", "reloading", "inactive", "failed", "unknown", "not-installed"]);
export type CiRunnerState = z.infer<typeof CiRunnerStateSchema>;

// Why a runner is down on purpose, so neither the fleet service's keeper nor a reader takes it for broken: stopped from
// the board (`board`), drained and stopped once its job ended (`drain`), or paused by `wsl-workers.sh` for a Windows
// smoke job (`smoke`).
export const CiRunnerHoldSchema = z.enum(["board", "drain", "smoke"]);
export type CiRunnerHold = z.infer<typeof CiRunnerHoldSchema>;

export const CiRunnerSchema = z.object({
    // The runner's name at GitHub (`agentName` in its `.runner`), else the one its unit's name carries.
    name: CiRunnerNameSchema,
    // The systemd unit, `actions.runner.<scope>.<name>.service`.
    unit: z.string(),
    // The runner's own folder (the unit's WorkingDirectory), as the machine spells it.
    dir: z.string(),
    // The account the unit runs the runner as.
    user: z.string(),
    // What it is registered to (`gitHubUrl` in its `.runner`): a repository or an organisation.
    url: z.string().optional(),
    // The runner's version, read off the `bin` link a self-update points at `bin.<version>`.
    version: z.string().optional(),
    // The light lane (ci-runner.md): an instance named `<host>-light-<n>`, which takes only a pipeline's first two jobs.
    light: z.boolean(),
    state: CiRunnerStateSchema,
    // Running a job right now: its Runner.Worker process is alive.
    busy: z.boolean(),
    // When that job's worker started, ISO; absent while idle.
    busySince: z.string().optional(),
    // The job's name, read from the worker's own log where it says it; absent while idle or where the log does not.
    job: z.string().optional(),
    // Down on purpose, and why; absent for a runner nobody holds down.
    held: CiRunnerHoldSchema.optional(),
    // A drain is waiting for its job to end, after which the runner is stopped.
    draining: z.boolean(),
});
export type CiRunner = z.infer<typeof CiRunnerSchema>;

// One pass of one of the fleet service's rounds: when, whether it only reported (`dryRun`), what it freed, and its lines.
export const CiFleetPassSchema = z.object({
    at: z.string(),
    dryRun: z.boolean(),
    freedBytes: z.number().int().nonnegative(),
    // What it did, one sentence a line, as the old scripts' journal lines read; at most the newest 200.
    lines: z.array(z.string()),
});
export type CiFleetPass = z.infer<typeof CiFleetPassSchema>;

// A shared cache under the fleet's cache root (`/ci-cache/<name>`), as the last janitor pass measured it.
export const CiCacheSchema = z.object({ name: z.string(), bytes: z.number().int().nonnegative() });
export type CiCache = z.infer<typeof CiCacheSchema>;

// The test-memory pool on this computer (`test-memory-pool.mjs`: one-GiB slot files that CI jobs flock), and what the
// fleet service holds of it for the Intentic sandboxes on the same engine, so CI sizes its test workers from what they
// leave. Slots 1..`reserved` are the gate band the service never takes.
export const CiSlotsSchema = z.object({
    dir: z.string(),
    total: z.number().int().positive(),
    reserved: z.number().int().nonnegative(),
    // Slots kept from CI for good, whatever the sandboxes hold: the host's floor (`--slots-usable` keeps this many usable).
    floor: z.number().int().nonnegative(),
    // Slots the service holds now: the floor and the sandboxes' share together.
    heldForSandboxes: z.number().int().nonnegative(),
    // Memory the sandboxes and sandbox runners on this engine use, as last measured.
    sandboxBytes: z.number().int().nonnegative(),
    // Slots CI jobs hold now, and slots nobody holds.
    heldByCi: z.number().int().nonnegative(),
    free: z.number().int().nonnegative(),
    at: z.string(),
});
export type CiSlots = z.infer<typeof CiSlotsSchema>;

// The fleet service as the agent found it.
export const CiFleetServiceSchema = z.object({
    // Installed and answering on its socket.
    running: z.boolean(),
    // Its unit exists, answering or not.
    installed: z.boolean(),
    version: z.string().optional(),
    // Why it is not answering, in words, where it is installed.
    problem: z.string().optional(),
});
export type CiFleetService = z.infer<typeof CiFleetServiceSchema>;

export const CiFleetSchema = z.object({
    service: CiFleetServiceSchema,
    runners: z.array(CiRunnerSchema),
    // The fleet's shared cache root on this computer.
    cacheRoot: z.string(),
    caches: z.array(CiCacheSchema),
    slots: CiSlotsSchema.optional(),
    keeper: CiFleetPassSchema.optional(),
    janitor: CiFleetPassSchema.optional(),
    // The host prune (Docker images, build cache, volumes), on a computer whose Docker is its own rather than shared
    // with Windows: omen's Docker Desktop is pruned by wsl-maintenance.ps1.
    prune: CiFleetPassSchema.optional(),
});
export type CiFleet = z.infer<typeof CiFleetSchema>;

// `start` and `stop` act now; `stop` refuses a runner that is running a job. `drain` stops it the moment its job ends
// (at once when idle) and `restart` is a drain followed by a start. A runner stopped from here is held down: the keeper
// leaves it until a `start`.
export const CiRunnerOpSchema = z.enum(["start", "stop", "drain", "restart"]);
export type CiRunnerOp = z.infer<typeof CiRunnerOpSchema>;

export const CiRunnerOpResultSchema = z.object({ said: z.string() });
export type CiRunnerOpResult = z.infer<typeof CiRunnerOpResultSchema>;

export const CI_RUNNER_LOG_TAIL_DEFAULT = 200;
export const CI_RUNNER_LOG_TAIL_MAX = 5000;
export const CiRunnerLogsSchema = z.object({ text: z.string() });
export type CiRunnerLogs = z.infer<typeof CiRunnerLogsSchema>;

// A GitHub Actions label as config.sh takes one: no comma, which separates them.
export const CiRunnerLabelSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);

// What the machine's `ci_runner_register` takes: a registration token GitHub minted for `url` an hour's use, the new
// runner's name and labels. The fleet service downloads the runner release, checks its SHA-256, configures it as
// `user` (default: the account the existing runners run as) in `<user's home>/actions-runner-<name>` and installs its unit.
export const CiRunnerRegisterArgsSchema = z
    .object({
        url: z.string().url().startsWith("https://github.com/"),
        token: z.string().min(10).max(200),
        name: CiRunnerNameSchema,
        labels: z.array(CiRunnerLabelSchema).min(1).max(20),
        user: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/).optional(),
    })
    .strict();
export type CiRunnerRegisterArgs = z.infer<typeof CiRunnerRegisterArgsSchema>;

// What `ci_runner_remove` takes: the runner and a removal token GitHub minted for its registration. Refused while it runs a job.
export const CiRunnerRemoveArgsSchema = z.object({ name: CiRunnerNameSchema, token: z.string().min(10).max(200) }).strict();
export type CiRunnerRemoveArgs = z.infer<typeof CiRunnerRemoveArgsSchema>;

// The daemon's route inputs: the device by its card id, then what the machine is asked.
const DeviceIdSchema = z.string().min(1);
export const DeviceCiFleetInputSchema = z.object({ id: DeviceIdSchema });
export type DeviceCiFleetInput = z.infer<typeof DeviceCiFleetInputSchema>;
export const DeviceCiRunnerOpInputSchema = z.object({ id: DeviceIdSchema, name: CiRunnerNameSchema, op: CiRunnerOpSchema });
export type DeviceCiRunnerOpInput = z.infer<typeof DeviceCiRunnerOpInputSchema>;
export const DeviceCiRunnerLogsInputSchema = z.object({
    id: DeviceIdSchema,
    name: CiRunnerNameSchema,
    tail: z.coerce.number().int().positive().max(CI_RUNNER_LOG_TAIL_MAX).optional(),
});
export type DeviceCiRunnerLogsInput = z.infer<typeof DeviceCiRunnerLogsInputSchema>;

// Register a new runner on a device for one workspace repository's GitHub remote: the daemon mints the registration
// token through the GitHub connection and never stores it.
export const DeviceCiRunnerRegisterInputSchema = z.object({
    id: DeviceIdSchema,
    // Workspace-relative repository directory whose GitHub remote the runner serves.
    repo: z.string().min(1).max(500),
    name: CiRunnerNameSchema,
    labels: z.array(CiRunnerLabelSchema).min(1).max(20),
});
export type DeviceCiRunnerRegisterInput = z.infer<typeof DeviceCiRunnerRegisterInputSchema>;
export const DeviceCiRunnerRemoveInputSchema = z.object({ id: DeviceIdSchema, name: CiRunnerNameSchema });
export type DeviceCiRunnerRemoveInput = z.infer<typeof DeviceCiRunnerRemoveInputSchema>;
