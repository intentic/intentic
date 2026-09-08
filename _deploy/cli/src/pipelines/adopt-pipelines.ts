import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DesiredStateGraph } from "@intentic/graph";
import type { ForgejoAdmin, ForgejoApi } from "@intentic/providers";
import { renderTemplate } from "../lib/templates.js";
import { collectSecrets } from "../secrets/secrets.js";

// Repo Actions secrets the intent pipeline pushes the artifact with (HTTP Basic, admin password token).
export const GIT_USER_SECRET = "INTENTIC_GIT_USER";
export const GIT_TOKEN_SECRET = "INTENTIC_GIT_TOKEN";

// Job env-var names the resolve pipeline binds those secrets to; GIT_TOKEN also authenticates its secret PUTs.
const GIT_USER_ENV = "GIT_USER";
export const GIT_TOKEN_ENV = "GIT_TOKEN";

// Package the pipelines install the CLI from, pinned to the adopting CLI's own version via `pnpm dlx`.
const CLI_PACKAGE = "@intentic/cli";
// Git ref the apply pipeline force-moves onto each successfully-applied commit; next apply's prune baseline.
const APPLIED_TAG = "intentic-applied";

export const INTENT_WORKFLOW_PATH = ".forgejo/workflows/resolve.yaml";
export const APPLY_WORKFLOW_PATH = ".forgejo/workflows/apply.yaml";

// Forgejo rejects a reserved-prefix secret name; such keys store under an INTENTIC_-prefixed name instead.
const RESERVED_SECRET_PREFIXES = ["GITHUB_", "GITEA_", "FORGEJO_"];
export const forgejoSecretName = (key: string): string =>
    RESERVED_SECRET_PREFIXES.some((prefix) => key.startsWith(prefix)) ? `INTENTIC_${key}` : key;

export interface PipelineInputs {
    // Adopting CLI's version, baked into `pnpm dlx @intentic/cli@<version>` in both pipelines.
    readonly cliVersion: string;
    // Forgejo admin user, repo owner, and git-push identity.
    readonly user: string;
    // Public git domain (git.<zone>); the REST + clone-url authority.
    readonly domain: string;
    // Intent config the resolve pipeline reads and the artifact it writes (bare names within each repo).
    readonly configFile: string;
    readonly artifactFile: string;
    // Repo names under the admin owner.
    readonly intentRepo: string;
    readonly desiredStateRepo: string;
    // Every secret key the apply pipeline injects into the job env, resolved from process.env when apply runs.
    readonly applySecretKeys: readonly string[];
    // Generated secret key holding the Forgejo admin password; apply uses it to push the applied-tag.
    readonly forgejoPasswordKey: string;
}

const cloneUrl = (inputs: PipelineInputs, repo: string): string => `https://${inputs.domain}/${inputs.user}/${repo}.git`;

// On a push that changes the config, resolves a fresh artifact and pushes it to desired-state (which applies it). Auth
// rides on INTENTIC_GIT_* secrets via http.extraHeader, never .git/config.
export const intentWorkflowYaml = (inputs: PipelineInputs): string =>
    renderTemplate("workflows/resolve.yaml", {
        configFile: inputs.configFile,
        artifactFile: inputs.artifactFile,
        gitUserEnv: GIT_USER_ENV,
        gitUserSecret: GIT_USER_SECRET,
        gitTokenEnv: GIT_TOKEN_ENV,
        gitTokenSecret: GIT_TOKEN_SECRET,
        desiredStateCloneUrl: cloneUrl(inputs, inputs.desiredStateRepo),
        cliPackage: CLI_PACKAGE,
        cliVersion: inputs.cliVersion,
        user: inputs.user,
        domain: inputs.domain,
    });

// On a push that changes the artifact, applies it. Full history lets it diff against the intentic-applied tag (the
// prune baseline), moving the tag on success.
export const applyWorkflowYaml = (inputs: PipelineInputs): string =>
    renderTemplate("workflows/apply.yaml", {
        artifactFile: inputs.artifactFile,
        envEntries: inputs.applySecretKeys.map((key) => ({ env: key, secret: forgejoSecretName(key) })),
        appliedTag: APPLIED_TAG,
        cliPackage: CLI_PACKAGE,
        cliVersion: inputs.cliVersion,
        user: inputs.user,
        forgejoPasswordKey: inputs.forgejoPasswordKey,
    });

// Writes a workflow file into a local repo dir so adopt's normal commit/push carries it, no API commit needed.
export const writeWorkflow = async (repoDir: string, workflowPath: string, content: string): Promise<void> => {
    const full = join(repoDir, workflowPath);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
};

// Seeds both control-plane repos with their pipelines, before the push that adopts them.
export const writeControlPlaneWorkflows = async (intentDir: string, targetDir: string, inputs: PipelineInputs): Promise<void> => {
    await writeWorkflow(intentDir, INTENT_WORKFLOW_PATH, intentWorkflowYaml(inputs));
    await writeWorkflow(targetDir, APPLY_WORKFLOW_PATH, applyWorkflowYaml(inputs));
};

// Resolves the values behind the graph's secrets for pushing to Forgejo: env keys from process.env, generated keys from
// .secrets.json. A key with no value yet is simply omitted.
export const collectSecretValues = (
    graph: DesiredStateGraph,
    env: Readonly<Record<string, string | undefined>>,
    generatedValues: Readonly<Record<string, string>>,
): Record<string, string> => {
    const { env: envKeys, generated: generatedKeys } = collectSecrets(graph);
    const values: Record<string, string> = {};
    for (const key of envKeys) {
        const value = env[key];
        if (value !== undefined && value !== "") {
            values[key] = value;
        }
    }
    for (const key of generatedKeys) {
        const value = generatedValues[key];
        if (value !== undefined) {
            values[key] = value;
        }
    }
    return values;
};

// Sets a repo's Actions secrets from a name to value map, once the repo exists.
export const setRepoSecrets = async (
    args: ForgejoAdmin & {
        readonly api: ForgejoApi;
        readonly owner: string;
        readonly name: string;
        readonly secrets: Readonly<Record<string, string>>;
    },
): Promise<void> => {
    for (const [secretName, data] of Object.entries(args.secrets)) {
        await args.api.setRepoSecret({
            baseUrl: args.baseUrl,
            user: args.user,
            password: args.password,
            owner: args.owner,
            name: args.name,
            secretName: forgejoSecretName(secretName),
            data,
        });
    }
};
