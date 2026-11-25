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

// (2026-11-25) Who deployed a stack: the machine records the calling sandbox (its link, never a value the call names) in
// `.intentic-deploy.json`, and refuses deploy_stack, stack_action and stack_logs on that stack to every other sandbox.
// `list_stacks` shows it on managed stacks so a board can say "deployed by another sandbox" instead of offering buttons.
export const StackOwnerSchema = z.object({
    // The sandbox's URL as the link knows it, and whether that is the caller.
    sandbox: z.string(),
    you: z.boolean(),
});
export type StackOwner = z.infer<typeof StackOwnerSchema>;

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
    // (2026-11-25) The sandbox that deployed a managed stack, from an agent with `stacks-managed`; absent on an unmanaged
    // stack, on one deployed before the agent recorded owners, and from an older agent.
    owner: StackOwnerSchema.optional(),
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
// and brings it up with `--build`. A `.env` already in that folder is kept and never overwritten or sent. A stack a
// repository declares in its stacks manifest (STACKS_MANIFEST_PATH) is deployed through the deploys engine instead (schemas/deploys.ts),
// which renders its `.env` from the sandbox's secrets under that stack's own grants.
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

// (2026-11-25) MANAGED DEPLOYS: what a stack declared in a repository's stacks manifest (schemas/deploys.ts) adds to a deploy
// (schemas/deploys.ts). The daemon renders every `{{secret:…}}` before sending, so these fields carry values, over the
// device link only, and the machine writes them where compose and docker read them and nowhere else. Sent only to an
// agent advertising `stacks-managed` (hosts.ts): the args are strict, and an older agent rejects a field it lacks.

// How the stack's images come to be: `build` is `up --build` from the deployed tree (what every deploy did before),
// `images` pulls what the compose file names and never builds.
export const StackDeployModeSchema = z.enum(["images", "build"]);
export type StackDeployMode = z.infer<typeof StackDeployModeSchema>;

// A registry login, rendered: written into the stack's OWN docker config (`<stack>/.intentic-stack/docker/config.json`), never
// the machine's, and handed to compose as DOCKER_CONFIG for this stack's pulls alone.
export const StackRegistryLoginSchema = z
    .object({
        host: z
            .string()
            .min(1)
            .max(253)
            .regex(/^[A-Za-z0-9.-]+(?::\d{1,5})?$/, "a registry host, like ghcr.io or registry.gitlab.com"),
        username: z.string().min(1).max(200),
        password: z.string().min(1).max(10_000),
    })
    .strict();
export type StackRegistryLogin = z.infer<typeof StackRegistryLoginSchema>;

// A command run by the machine's shell in the stack's folder (`sh -c` on Linux and macOS), with COMPOSE_PROJECT_NAME set
// to the stack. `preDeploy` runs after the new files are in place and before compose touches a container, and a non-zero
// exit stops the deploy there; `postDeploy` runs once the stack is healthy, and its failure fails the deploy.
export const StackHookSchema = z.string().min(1).max(4000);
export const StackHooksSchema = z.object({ preDeploy: StackHookSchema.optional(), postDeploy: StackHookSchema.optional() }).strict();
export type StackHooks = z.infer<typeof StackHooksSchema>;

export const STACK_HEALTH_TIMEOUT_DEFAULT_S = 180;
// At most ten minutes: the whole deploy (files, hooks, pull, up, health) is one device call under the daemon's ceiling.
export const STACK_HEALTH_TIMEOUT_MAX_S = 600;
// How the machine decides a deploy came up: every service running and none restarting, each healthcheck a service
// declares `healthy`, and each `http` URL (fetched from the machine, so a stack's own loopback ports count) answering
// 2xx, all within `timeoutSeconds`. The first seconds are not trusted: an old container may still be answering.
export const StackHealthSchema = z
    .object({
        timeoutSeconds: z.number().int().min(10).max(STACK_HEALTH_TIMEOUT_MAX_S).default(STACK_HEALTH_TIMEOUT_DEFAULT_S),
        http: z.array(z.string().url().max(2000)).max(5).default([]),
    })
    .strict();
export type StackHealth = z.infer<typeof StackHealthSchema>;

// service → image reference pinned by digest (`ghcr.io/o/api@sha256:…`), laid over the compose file as an override
// (`<stack>/.intentic-stack/pins.yaml`): how a rollback runs exactly the images the earlier deploy ran.
export const StackImagePinsSchema = z.record(z.string().min(1).max(200), z.string().min(1).max(500));
export type StackImagePins = z.infer<typeof StackImagePinsSchema>;

// The machine's own tool arguments for a deploy: the folder `stageArtifact` unpacked the bundle into, the stack name,
// the compose file inside it and the commit, recorded beside the stack. Every field after `commit` is a managed deploy's
// (`stacks-managed`), absent from a plain one, which behaves exactly as before: `--build`, and any `.env` there kept.
export const DeployStackToolArgsSchema = z
    .object({
        source: z.string().min(1),
        name: StackNameSchema,
        composeFile: ComposeFilePathSchema,
        commit: z.string().regex(/^[0-9a-f]{40,64}$/),
        mode: StackDeployModeSchema.optional(),
        // The whole `.env`, rendered (dotenv lines). Written 0600 and atomically, its sha256 kept in the deploy record; a
        // `.env` there that is not the one the last managed deploy wrote (hand-placed, or edited since) is refused, never
        // overwritten, and the refusal says so. Absent: a `.env` there is left as it is.
        env: z.string().max(256 * 1024).optional(),
        registries: z.array(StackRegistryLoginSchema).max(10).optional(),
        hooks: StackHooksSchema.optional(),
        health: StackHealthSchema.optional(),
        pins: StackImagePinsSchema.optional(),
        // Take over a compose project of this name that no deploy put here (a stack another tool ran, such as Komodo),
        // when none of its containers is running: its named volumes, which compose prefixes with the project name, carry
        // over. A running one is still refused.
        adopt: z.boolean().optional(),
    })
    .strict();
export type DeployStackToolArgs = z.infer<typeof DeployStackToolArgsSchema>;

// service → the image it runs, pinned (`repo@sha256:…`); a locally built image has no registry digest and reads as its
// image id (`sha256:…`).
export const StackImageDigestsSchema = z.record(z.string(), z.string());
export type StackImageDigests = z.infer<typeof StackImageDigestsSchema>;

// What `deploy_stack` answers. A plain deploy answers `path` and `output` alone, as it always did; a managed one adds
// what it ran and how it came up. A failure is a tool error carrying the same story in words.
export const DeployStackToolResultSchema = z.object({
    path: z.string(),
    output: z.string(),
    digests: StackImageDigestsSchema.optional(),
    // sha256 (hex) of the `.env` this deploy wrote; absent when it wrote none.
    envDigest: z.string().optional(),
    // How long the stack took to come up healthy, in seconds.
    healthySeconds: z.number().optional(),
});
export type DeployStackToolResult = z.infer<typeof DeployStackToolResultSchema>;
