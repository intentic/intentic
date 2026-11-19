import { z } from "zod";

// DOCKER COMPOSE STACKS ON ONE OF THE OWNER'S COMPUTERS: what runs there besides Intentic's own sandboxes, read and
// driven over the connection the machine already holds open, so a server the owner paired needs no second agent (a
// Komodo Periphery) to be deployed to. The machine runs `docker compose` itself and checks its own switches: reading and
// driving a stack takes "Run commands", receiving a repository to deploy takes "Run programs this sandbox sends" too.
// The daemon relays (_sandbox/sandbox hosts/stacks/device-stacks.ts); the Deployments extension draws the board.

// A compose project name as Docker accepts one: lowercase letters, digits, dash and underscore, starting with a letter
// or a digit. The name is also the folder a deployed stack lives in on the machine, so it is one plain path segment.
export const StackNameSchema = z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,62}$/, "lowercase letters, digits, dash and underscore, starting with a letter or digit, at most 63");
export type StackName = z.infer<typeof StackNameSchema>;

// Docker's own container states, plus `unknown` for one a newer engine names that this list does not.
export const StackContainerStateSchema = z.enum(["running", "restarting", "paused", "exited", "created", "dead", "removing", "unknown"]);
export type StackContainerState = z.infer<typeof StackContainerStateSchema>;

export const StackServiceSchema = z.object({
    // The compose service name (`com.docker.compose.service`).
    service: z.string(),
    container: z.string(),
    image: z.string(),
    state: StackContainerStateSchema,
    // Docker's status prose ("Up 3 hours (healthy)", "Exited (1) 2 minutes ago"), passed through.
    status: z.string(),
    // The healthcheck's verdict, when the service declares one.
    health: z.enum(["healthy", "unhealthy", "starting"]).optional(),
});
export type StackService = z.infer<typeof StackServiceSchema>;

export const DeviceStackSchema = z.object({
    name: StackNameSchema,
    // Compose's own summary ("running(2)", "exited(1), running(1)"), passed through.
    status: z.string(),
    // The compose files the project was started from, as absolute paths on the machine; empty when compose no longer
    // knows them (a project whose files were deleted still lists its containers).
    configFiles: z.array(z.string()),
    // The project's working directory (`com.docker.compose.project.working_dir`), when its containers record one.
    workingDir: z.string().optional(),
    // Deployed by Intentic into the machine's stacks folder (`root`), rather than started by hand or by another tool.
    managed: z.boolean(),
    // A project whose containers belong to an Intentic sandbox (`dev.intentic.kind`): the Devices view drives those,
    // not a deployments board.
    sandbox: z.boolean(),
    services: z.array(StackServiceSchema),
});
export type DeviceStack = z.infer<typeof DeviceStackSchema>;

export const DeviceStacksSchema = z.object({
    // Where a stack this sandbox deploys lands on the machine (`<root>/<name>`), as the machine spells its paths.
    root: z.string(),
    stacks: z.array(DeviceStackSchema),
});
export type DeviceStacks = z.infer<typeof DeviceStacksSchema>;

// `up` applies the compose files as they are (`up -d --remove-orphans`), `pull` fetches newer images and then applies.
// Nothing here removes a stack or a volume: `down` and `down -v` are a person's to run.
export const StackOpSchema = z.enum(["up", "restart", "start", "stop", "pull"]);
export type StackOp = z.infer<typeof StackOpSchema>;

// What the machine printed doing it, for the row that asked; a refusal arrives as an error instead.
export const StackOpResultSchema = z.object({ output: z.string() });
export type StackOpResult = z.infer<typeof StackOpResultSchema>;

export const STACK_LOG_TAIL_DEFAULT = 200;
export const STACK_LOG_TAIL_MAX = 5000;
export const StackLogsSchema = z.object({ text: z.string() });
export type StackLogs = z.infer<typeof StackLogsSchema>;

// A compose file inside the deployed repository, relative to its root: forward slashes, no `..`, no leading slash.
export const ComposeFilePathSchema = z
    .string()
    .min(1)
    .max(300)
    .regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/, "a path inside the repository, like docker-compose.yml or deploy/compose.yaml");

// The daemon's route inputs: the device by its card id, then what the machine is asked.
const DeviceIdSchema = z.string().min(1);
export const DeviceStacksInputSchema = z.object({ id: DeviceIdSchema });
export const DeviceStackOpInputSchema = z.object({ id: DeviceIdSchema, name: StackNameSchema, op: StackOpSchema });
export type DeviceStackOpInput = z.infer<typeof DeviceStackOpInputSchema>;
export const DeviceStackLogsInputSchema = z.object({
    id: DeviceIdSchema,
    name: StackNameSchema,
    tail: z.coerce.number().int().positive().max(STACK_LOG_TAIL_MAX).optional(),
});
export type DeviceStackLogsInput = z.infer<typeof DeviceStackLogsInputSchema>;

// Deploy a workspace repository's COMMITTED tree (its HEAD, never the uncommitted edits around it) to a device as a
// compose stack: the daemon packs it, carries it over the device link, and the machine copies it into `<root>/<name>`
// and brings it up with `--build`. A `.env` already in that folder is kept and never overwritten or sent: secrets are
// placed there through an agent turn, where every secret gate applies.
export const DeviceStackDeployInputSchema = z.object({
    id: DeviceIdSchema,
    name: StackNameSchema,
    // Workspace-relative repository directory, the same `repo` key the rest of the app joins on.
    repo: z.string().min(1).max(500),
    // Absent: the first of compose.yaml, compose.yml, docker-compose.yaml, docker-compose.yml at the repository root.
    composeFile: ComposeFilePathSchema.optional(),
});
export type DeviceStackDeployInput = z.infer<typeof DeviceStackDeployInputSchema>;

export const DeviceStackDeployResultSchema = z.object({
    stack: StackNameSchema,
    // The folder the stack runs from on the machine.
    path: z.string(),
    // The commit that was deployed, full sha.
    commit: z.string(),
    // What `docker compose up` printed.
    output: z.string(),
});
export type DeviceStackDeployResult = z.infer<typeof DeviceStackDeployResultSchema>;

// The machine's own tool arguments for a deploy: the folder `stageArtifact` unpacked the bundle into, the stack name,
// the compose file inside it and the commit, recorded beside the stack.
export const DeployStackToolArgsSchema = z
    .object({
        source: z.string().min(1),
        name: StackNameSchema,
        composeFile: ComposeFilePathSchema,
        commit: z.string().regex(/^[0-9a-f]{40,64}$/),
    })
    .strict();
export type DeployStackToolArgs = z.infer<typeof DeployStackToolArgsSchema>;
