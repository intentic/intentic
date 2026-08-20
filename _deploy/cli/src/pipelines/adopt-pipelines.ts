import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DesiredStateGraph } from "@intentic/graph";
import type { ForgejoApi } from "@intentic/providers";
import { renderTemplate } from "../lib/templates.js";
import { collectSecrets } from "../secrets/secrets.js";

// The repo Actions secrets the INTENT pipeline pushes the resolved artifact into the desired-state repo with
// (HTTP Basic against Forgejo, the same scheme `adopt` pushes with). The token is the Forgejo admin password.
export const GIT_USER_SECRET = "INTENTIC_GIT_USER";
export const GIT_TOKEN_SECRET = "INTENTIC_GIT_TOKEN";

// The job env-var names the resolve pipeline binds those secrets to (and that the CLI reads): the resolve sync
// authenticates its Forgejo secret PUTs with GIT_TOKEN (the admin password).
const GIT_USER_ENV = "GIT_USER";
export const GIT_TOKEN_ENV = "GIT_TOKEN";

// The package the pipelines install the CLI from. The intent/desired-state repos do not depend on the CLI
// (only on @intentic/{sdk,graph}); the runner pulls it on demand via `pnpm dlx`, pinned to the adopting CLI's
// own version so the pipeline runs the same intentic the operator bootstrapped with.
const CLI_PACKAGE = "@intentic/cli";
// The git ref the apply pipeline force-moves onto each SUCCESSFULLY-applied commit. The next apply diffs the
// new artifact against the artifact at this tag (the last good state) to decide what to prune, so a failed
// apply, which never reaches the tag step, never corrupts the prune baseline.
const APPLIED_TAG = "intentic-applied";

export const INTENT_WORKFLOW_PATH = ".forgejo/workflows/resolve.yaml";
export const APPLY_WORKFLOW_PATH = ".forgejo/workflows/apply.yaml";

// Forgejo rejects an Actions secret whose name starts with a reserved prefix (HTTP 400 "invalid secret
// name"), so a generated key like FORGEJO_ADMIN_PASSWORD cannot be stored verbatim. Map such keys to an
// INTENTIC_-prefixed STORE name; the workflow binds the original env-var name to this store name, so the CLI
// still reads the real key. Used on both sides (the PUT and the `${{ secrets.* }}` reference) so they agree.
const RESERVED_SECRET_PREFIXES = ["GITHUB_", "GITEA_", "FORGEJO_"];
export const forgejoSecretName = (key: string): string =>
    RESERVED_SECRET_PREFIXES.some((prefix) => key.startsWith(prefix)) ? `INTENTIC_${key}` : key;

export interface PipelineInputs {
    // The adopting CLI's version, baked into `pnpm dlx @intentic/cli@<version>` in both pipelines.
    readonly cliVersion: string;
    // The Forgejo admin user, the repo owner and the git-push identity.
    readonly user: string;
    // The public git domain (git.<zone>); the REST + clone-url authority.
    readonly domain: string;
    // The intent config the resolve pipeline reads and the artifact it writes (bare names within each repo).
    readonly configFile: string;
    readonly artifactFile: string;
    // The repo names under the admin owner.
    readonly intentRepo: string;
    readonly desiredStateRepo: string;
    // Every secret key the apply pipeline injects into the job env (the graph's env + generated secrets),
    // `apply` resolves each from process.env, and the generated ones win over `.secrets.json` (env-first).
    readonly applySecretKeys: readonly string[];
    // The generated secret key holding the Forgejo admin password; the apply pipeline pushes the applied-tag
    // with it (admin Basic auth), so no separate git-push secret is needed on the desired-state repo.
    readonly forgejoPasswordKey: string;
}

const cloneUrl = (inputs: PipelineInputs, repo: string): string => `https://${inputs.domain}/${inputs.user}/${repo}.git`;

// On a push that changes the authored config, resolve it into a fresh artifact and push that into the
// desired-state repo (whose own pipeline then applies it). The desired-state clone/push authenticates with the
// INTENTIC_GIT_* repo secrets via http.extraHeader, so credentials never touch .git/config.
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

// On a push that changes the artifact, apply it. Full history is fetched so the last successfully-applied
// commit (tagged `intentic-applied`) can be read as the prune baseline. On success the tag is force-moved onto
// the applied commit and pushed, so it always points at the last good state.
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

// Write a workflow file into a local repo dir (creating .forgejo/workflows/), so `adopt`'s normal add/commit/
// push carries it, no API commit, no extra trigger.
export const writeWorkflow = async (repoDir: string, workflowPath: string, content: string): Promise<void> => {
    const full = join(repoDir, workflowPath);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
};

// Seed both control-plane repos with their pipelines, before the push that adopts them.
export const writeControlPlaneWorkflows = async (intentDir: string, targetDir: string, inputs: PipelineInputs): Promise<void> => {
    await writeWorkflow(intentDir, INTENT_WORKFLOW_PATH, intentWorkflowYaml(inputs));
    await writeWorkflow(targetDir, APPLY_WORKFLOW_PATH, applyWorkflowYaml(inputs));
};

// Resolve the VALUES behind the graph's secrets, for pushing into Forgejo Actions: env keys from the loaded
// process.env, generated keys from the .secrets.json map. A declared key with no value yet is simply absent,
// the caller pushes what exists and `apply` fails loudly on the rest. Shared by `adopt` and `secrets push`.
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

// Set a repo's Actions secrets from a name -> value map, after the repo exists (post-adopt push).
export const setRepoSecrets = async (args: {
    readonly api: ForgejoApi;
    readonly baseUrl: string;
    readonly user: string;
    readonly password: string;
    readonly owner: string;
    readonly name: string;
    readonly secrets: Readonly<Record<string, string>>;
}): Promise<void> => {
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
