import { STATE_DIR } from "@intentic/constants";
import { z } from "zod";
import {
    ComposeFilePathSchema,
    StackDeployModeSchema,
    StackHealthSchema,
    StackHookSchema,
    StackImageDigestsSchema,
    StackImagePinsSchema,
    StackNameSchema,
} from "./device-stacks.js";

/* MANAGED ENVIRONMENTS (2026-11-25): compose stacks a project's own sandbox deploys to the owner's servers and keeps
   running, in place of an outside orchestrator (Komodo). What a stack IS lives in the project's repository, in
   STACKS_MANIFEST_PATH beside `run.json` and `checks.json`, so a change to production is a reviewed land like any
   other change; what it RECEIVES (secret values) lives in this sandbox's secret store and is rendered by the daemon at
   deploy time, never by an agent turn; WHERE it runs is a paired computer, whose agent records which sandbox deployed
   each stack and refuses every other (device-stacks.ts StackOwnerSchema).

   Deploys are pulled, not pushed: the forge's webhook says a job passed (ci/), and the sandbox deploys that commit. No
   deploy credential sits in CI, and the outcome goes back to the forge as a Deployment (GitHub) or a commit status
   (GitLab). */

// ---- the manifest: STACKS_MANIFEST_PATH, relative to the repository's root ----------------------------------------

export const STACKS_MANIFEST_PATH = `${STATE_DIR}/stacks.json`;

// An environment variable's name as compose interpolates it.
export const StackEnvKeySchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, "a variable name: letters, digits and underscores");

// A value, as written in the manifest: literal text, `{{secret:NAME}}` for a value from this sandbox's secret store, and
// `{{deploy:sha}}`, `{{deploy:sha8}}`, `{{deploy:ref}}` or `{{deploy:stack}}` for the deploy's own commit, branch and
// name. A value with lines is written into `.env` quoted.
export const StackEnvValueSchema = z.string().max(64 * 1024);
export const DEPLOY_REFERENCE = /\{\{deploy:(sha|sha8|ref|stack)\}\}/g;

export const StackRegistrySpecSchema = z
    .object({
        host: z.string().min(1).max(253),
        username: z.string().min(1).max(200),
        // Normally `{{secret:NAME}}`; rendered like an env value and never written anywhere but the stack's docker config.
        password: z.string().min(1).max(1000),
    })
    .strict();
export type StackRegistrySpec = z.infer<typeof StackRegistrySpecSchema>;

// How often a `registry` trigger looks for newer images behind the tags the compose file names: 5m to 24h.
export const DeployIntervalSchema = z.string().regex(/^(\d{1,4})(m|h)$/, "an interval like 15m or 6h");
export const deployIntervalMs = (interval: string): number => {
    const match = /^(\d{1,4})(m|h)$/.exec(interval);
    if (match === null) {
        throw new Error(`"${interval}" is not an interval like 15m or 6h`);
    }
    const ms = Number(match[1]) * (match[2] === "h" ? 3_600_000 : 60_000);
    return Math.min(Math.max(ms, 5 * 60_000), 24 * 3_600_000);
};

// What starts a deploy by itself. Without one, a stack deploys only when asked (the board, the `deploys` CLI, a tool).
export const DeployTriggerSchema = z.union([
    // A CI run passing on the branch: `job` names the job whose success means the images are published (deploys start
    // the moment that job ends, not when the whole workflow does); `workflow` narrows to one workflow (GitHub's name).
    // Neither: the first run that passes on the branch. A commit older than what the stack runs never replaces it.
    z.object({ ci: z.object({ branch: z.string().min(1).max(255), workflow: z.string().min(1).max(255).optional(), job: z.string().min(1).max(255).optional() }).strict() }).strict(),
    // Newer images behind the same tags (`:main`, `:latest`, a third-party image): pulled every `every`, and a deploy
    // recorded only when a digest changed.
    z.object({ registry: z.object({ every: DeployIntervalSchema }).strict() }).strict(),
    // Promotion: deploy this stack at the commit and image digests another stack of this repository just deployed
    // successfully (staging, then production).
    z.object({ after: z.object({ stack: StackNameSchema }).strict() }).strict(),
]);
export type DeployTrigger = z.infer<typeof DeployTriggerSchema>;

export const StackSpecSchema = z
    .object({
        // The compose project name on the machine, which prefixes its named volumes: keeping a stack's old name keeps its
        // data. Unique across the owner's servers, since the machine refuses a name another sandbox owns.
        name: StackNameSchema,
        // The computer it runs on, by its device card's name or id in this sandbox.
        device: z.string().min(1).max(200),
        // The compose file inside the repository. Absent: compose's own defaults at the repository root.
        compose: ComposeFilePathSchema.optional(),
        mode: StackDeployModeSchema.default("images"),
        env: z.record(StackEnvKeySchema, StackEnvValueSchema).default({}),
        registries: z.array(StackRegistrySpecSchema).max(10).default([]),
        triggers: z.array(DeployTriggerSchema).max(10).default([]),
        hooks: z.object({ preDeploy: StackHookSchema.optional(), postDeploy: StackHookSchema.optional() }).strict().default({}),
        health: StackHealthSchema.optional(),
        // A deploy that does not come up healthy: go back to what ran before (`rollback`), or leave it for a person (`stay`).
        onFailure: z.enum(["rollback", "stay"]).default("rollback"),
        // A secret this stack receives was changed in the store: redeploy at the commit it runs, or only say so.
        onSecretChange: z.enum(["redeploy", "notify"]).default("notify"),
        description: z.string().max(500).optional(),
    })
    .strict();
export type StackSpec = z.infer<typeof StackSpecSchema>;
export type StackSpecInput = z.input<typeof StackSpecSchema>;

export const StacksManifestSchema = z
    .object({
        $schema: z.string().optional(),
        stacks: z.array(StackSpecSchema).max(50),
    })
    .strict()
    .superRefine((manifest, ctx) => {
        const seen = new Set<string>();
        for (const [index, stack] of manifest.stacks.entries()) {
            if (seen.has(stack.name)) {
                ctx.addIssue({ code: "custom", path: ["stacks", index, "name"], message: `"${stack.name}" is declared twice` });
            }
            seen.add(stack.name);
        }
        for (const [index, stack] of manifest.stacks.entries()) {
            for (const trigger of stack.triggers) {
                if ("after" in trigger && !seen.has(trigger.after.stack)) {
                    ctx.addIssue({ code: "custom", path: ["stacks", index, "triggers"], message: `"after" names "${trigger.after.stack}", which this file does not declare` });
                }
                if ("after" in trigger && trigger.after.stack === stack.name) {
                    ctx.addIssue({ code: "custom", path: ["stacks", index, "triggers"], message: "a stack cannot follow itself" });
                }
            }
        }
    });
export type StacksManifest = z.infer<typeof StacksManifestSchema>;

// The secret names a stack's manifest entry reads: env values and registry passwords. What a grant must cover.
const SECRET_NAME = /\{\{secret:([A-Za-z0-9_./-]+)\}\}/g;
export const stackSecretNames = (stack: Pick<StackSpec, "env" | "registries">): string[] => {
    const names = new Set<string>();
    for (const text of [...Object.values(stack.env), ...stack.registries.map((registry) => registry.password)]) {
        for (const match of text.matchAll(SECRET_NAME)) {
            names.add(match[1] ?? "");
        }
    }
    names.delete("");
    return [...names].sort();
};

// ---- the engine's records ----------------------------------------------------------------------------------------

// What started a deploy.
export const DeployTriggerKindSchema = z.enum(["manual", "ci", "registry", "after", "rollback", "promote", "secret-change"]);
export type DeployTriggerKind = z.infer<typeof DeployTriggerKindSchema>;

export const DeployOutcomeSchema = z.enum([
    // Waiting for the stack's lock, or for the one ahead of it.
    "queued",
    "running",
    "succeeded",
    // Came up unhealthy, or a hook or compose failed; `error` says which.
    "failed",
    // Failed, and the stack was put back on the previous successful deploy (`rolledBackTo`).
    "rolled-back",
    // A newer commit for the same stack arrived while this one waited, so it never ran.
    "superseded",
    // Never started: a secret not granted to the stack, a device without the switches or features it needs, a manifest
    // that does not parse, a stack another sandbox owns. `error` says which, in words a person can act on.
    "refused",
]);
export type DeployOutcome = z.infer<typeof DeployOutcomeSchema>;

export const DeployRecordSchema = z.object({
    id: z.string(),
    // The repository that declares the stack (workspace-relative) and the stack's name in its manifest.
    repo: z.string(),
    stack: StackNameSchema,
    device: z.string(),
    commit: z.string(),
    ref: z.string().optional(),
    trigger: z.object({
        kind: DeployTriggerKindSchema,
        // One line: the CI run and job, the person, the conversation, the stack promoted from.
        detail: z.string().max(300).optional(),
        url: z.string().optional(),
    }),
    outcome: DeployOutcomeSchema,
    queuedAt: z.string(),
    startedAt: z.string().optional(),
    endedAt: z.string().optional(),
    // What it ran, once it ran: service → pinned image, the `.env`'s sha256, and which secret names it received (never a value).
    digests: StackImageDigestsSchema.optional(),
    // What it was asked to pin, service → image by digest: a rollback's or a promotion's images, kept on the record so one
    // still waiting when the daemon restarts runs them too.
    pins: StackImagePinsSchema.optional(),
    envDigest: z.string().optional(),
    secretNames: z.array(z.string()).default([]),
    healthySeconds: z.number().optional(),
    rolledBackTo: z.string().optional(),
    error: z.string().max(4000).optional(),
    // The end of what compose and the hooks printed.
    outputTail: z.string().max(20_000).optional(),
    // Where the forge shows it, once reported (a GitHub Deployment, a GitLab status).
    forgeUrl: z.string().optional(),
});
export type DeployRecord = z.infer<typeof DeployRecordSchema>;

// Which secrets a stack may receive, as the owner allowed them. A deploy needing one not listed here is `refused` and
// raises a card asking for it; nothing is rendered until the owner answers.
export const DeployGrantSchema = z.object({
    repo: z.string(),
    stack: StackNameSchema,
    device: z.string(),
    secrets: z.array(z.string()),
    grantedBy: z.string().optional(),
    grantedAt: z.string(),
});
export type DeployGrant = z.infer<typeof DeployGrantSchema>;

// How the stack is doing on its computer, as the monitor last read it.
export const StackHealthStateSchema = z.enum(["running", "unhealthy", "restarting", "stopped", "missing", "unreachable", "unknown"]);
export type StackHealthState = z.infer<typeof StackHealthStateSchema>;

export const DeployEnvironmentSchema = z.object({
    repo: z.string(),
    stack: StackNameSchema,
    device: z.string(),
    // The device card's id when `device` resolves to one, else absent and `problems` says why.
    deviceId: z.string().optional(),
    mode: StackDeployModeSchema,
    description: z.string().optional(),
    triggers: z.array(DeployTriggerSchema),
    // Every secret name the manifest reads, and those the owner has not granted to this stack yet.
    secrets: z.array(z.string()),
    ungranted: z.array(z.string()),
    // The secrets it received that changed in the store since its last successful deploy.
    secretsChanged: z.array(z.string()).default([]),
    // The last successful deploy, the one running or waiting now, and the newest attempt of any outcome.
    current: DeployRecordSchema.optional(),
    active: DeployRecordSchema.optional(),
    latest: DeployRecordSchema.optional(),
    state: StackHealthStateSchema,
    stateSince: z.string().optional(),
    // Owned by another sandbox on that computer: this one can read nothing there and deploy nothing.
    ownedElsewhere: z.boolean().default(false),
    // Why this environment cannot deploy now, each a sentence: a manifest error, an unknown device, a missing feature.
    problems: z.array(z.string()).default([]),
});
export type DeployEnvironment = z.infer<typeof DeployEnvironmentSchema>;

// ---- routes' inputs and answers (contracts/deploys.contract.ts) ---------------------------------------------------

export const DeployEnvironmentsResponseSchema = z.object({
    environments: z.array(DeployEnvironmentSchema),
    // Manifests that do not parse, per repository, so a broken file is shown rather than its stacks vanishing.
    manifestErrors: z.array(z.object({ repo: z.string(), error: z.string() })).default([]),
});
export type DeployEnvironmentsResponse = z.infer<typeof DeployEnvironmentsResponseSchema>;

export const StackRefSchema = z.object({ repo: z.string().min(1).max(500), stack: StackNameSchema });
export type StackRef = z.infer<typeof StackRefSchema>;

export const DeployRequestSchema = StackRefSchema.extend({
    // A full or abbreviated commit of the repository. Absent: the repository's HEAD as this workspace has it committed.
    commit: z.string().regex(/^[0-9a-f]{7,64}$/).optional(),
    // Wait for the deploy to end (up to the device's deadline) rather than answering once it is queued.
    wait: z.boolean().optional(),
    reason: z.string().max(300).optional(),
});
export type DeployRequest = z.infer<typeof DeployRequestSchema>;

export const RollbackRequestSchema = StackRefSchema.extend({
    // A record id from the stack's history. Absent: the successful deploy before the current one.
    to: z.string().optional(),
    wait: z.boolean().optional(),
});
export type RollbackRequest = z.infer<typeof RollbackRequestSchema>;

export const PromoteRequestSchema = z.object({
    repo: z.string().min(1).max(500),
    from: StackNameSchema,
    to: StackNameSchema,
    wait: z.boolean().optional(),
});
export type PromoteRequest = z.infer<typeof PromoteRequestSchema>;

export const DeployAnswerSchema = z.object({ record: DeployRecordSchema });
export type DeployAnswer = z.infer<typeof DeployAnswerSchema>;

export const DeployHistoryRequestSchema = StackRefSchema.extend({ limit: z.coerce.number().int().positive().max(200).optional() });
export const DeployHistoryResponseSchema = z.object({ records: z.array(DeployRecordSchema) });
export type DeployHistoryResponse = z.infer<typeof DeployHistoryResponseSchema>;

// Ask the owner, on a card, to grant a stack the secrets its manifest reads and it lacks: a `deploy` need, held as long as
// a need's raise holds by default. Answered as a raised need is (schemas/needs.ts NeedRaisedSchema): met, still open, or
// refused, with the sentence to print.
export const DeployGrantRequestSchema = StackRefSchema.extend({ why: z.string().max(280).optional() });

// (2026-11-25) The owner's card for a grant (schemas/needs.ts, kind `deploy`): the deploy engine renders a secret into a
// stack's `.env` only under the owner's grant, kept where no turn can write it. The agent asks by repository and stack;
// the daemon reads the manifest at HEAD and fills in the rest. Only the owner, or someone with Full access, signed in,
// can press it, and a yes grants exactly the names the card showed, on the computer it showed.
export const DeployNeedSchema = z.object({
    kind: z.literal("deploy"),
    repo: z.string().min(1).max(500).describe("The repository that declares the stack, workspace-relative."),
    stack: StackNameSchema.describe("The stack's name in that repository's stacks manifest."),
    device: z.string().min(1).max(200).describe("The computer it deploys to, as the manifest names it: a grant is for that computer alone."),
    secrets: z.array(z.string()).describe("Every secret name the stack's manifest reads, which a yes grants it."),
    ungranted: z.array(z.string()).describe("Those it has not been granted yet, when the card was raised."),
});
export type DeployNeed = z.infer<typeof DeployNeedSchema>;
// What an agent sends: the stack as it knows it.
export const DeployNeedAskSchema = z.object({ kind: z.literal("deploy"), repo: z.string().min(1).max(500), stack: StackNameSchema });
export const DeployGrantsResponseSchema = z.object({ grants: z.array(DeployGrantSchema) });
export type DeployGrantsResponse = z.infer<typeof DeployGrantsResponseSchema>;

// ---- the monitor --------------------------------------------------------------------------------------------------

// What `host_stats` answers (device feature `host-stats`).
export const HostStatsSchema = z.object({
    disks: z.array(
        z.object({
            // What the path is: Docker's data root, the stacks folder.
            role: z.enum(["docker", "stacks"]),
            path: z.string(),
            totalBytes: z.number(),
            freeBytes: z.number(),
        }),
    ),
    memory: z.object({ totalBytes: z.number(), availableBytes: z.number() }),
    // 1, 5 and 15 minute load averages; zeros where the OS keeps none (Windows).
    load: z.tuple([z.number(), z.number(), z.number()]),
    cpus: z.number(),
});
export type HostStats = z.infer<typeof HostStatsSchema>;

// The listener provider deploy events arrive under, so the owner's automations route them like CI's: a notice, a
// Discord message, a fix turn. `channelId` is `<repo>:<stack>`; `extra` carries the record id, commit and device.
export const DEPLOYS_PROVIDER = "deploys";
export const DEPLOY_EVENT_TYPES = [
    "deploy_succeeded",
    "deploy_failed",
    "deploy_rolled_back",
    "deploy_refused",
    "stack_unhealthy",
    "stack_recovered",
    "secrets_changed",
    "host_low_disk",
    "host_low_memory",
] as const;
export const DeployEventTypeSchema = z.enum(DEPLOY_EVENT_TYPES);
export type DeployEventType = z.infer<typeof DeployEventTypeSchema>;
