import { fakeForgejoApi } from "@intentic/providers";
import { parse } from "yaml";
import {
    applyWorkflowYaml,
    forgejoSecretName,
    GIT_TOKEN_SECRET,
    GIT_USER_SECRET,
    intentWorkflowYaml,
    type PipelineInputs,
    setRepoSecrets,
} from "./adopt-pipelines.js";

const inputs: PipelineInputs = {
    cliVersion: "1.2.3",
    user: "intentic",
    domain: "git.example.com",
    configFile: "deploy.config.ts",
    artifactFile: "desired-state.json",
    intentRepo: "intent",
    desiredStateRepo: "desired-state",
    applySecretKeys: ["CLOUDFLARE_API_TOKEN", "FORGEJO_ADMIN_PASSWORD", "HOST_SSH_KEY", "KOMODO_ADMIN_PASSWORD"],
    forgejoPasswordKey: "FORGEJO_ADMIN_PASSWORD",
};

test("the intent workflow resolves and pushes to the desired-state repo with the pinned CLI version", () => {
    const yaml = intentWorkflowYaml(inputs);
    // Post-adopt resolve syncs newly-required secrets into Forgejo and regenerates apply.yaml.
    expect(yaml).toContain(
        "pnpm dlx @intentic/cli@1.2.3 deploy resolve --config deploy.config.ts --out /tmp/ds/desired-state.json --sync-control-plane",
    );
    expect(yaml).toContain("clone https://git.example.com/intentic/desired-state.git /tmp/ds");
    // Git-push credential rides on the INTENTIC_GIT_* secrets, mapped to env.
    expect(yaml).toContain(`GIT_USER: \${{ secrets.${GIT_USER_SECRET} }}`);
    expect(yaml).toContain(`GIT_TOKEN: \${{ secrets.${GIT_TOKEN_SECRET} }}`);
    // Only pushes when resolve actually changed the artifact.
    expect(yaml).toContain("git diff --cached --quiet");
});

test("the apply workflow injects every secret, diffs against the applied tag, and re-stamps it on success", () => {
    const yaml = applyWorkflowYaml(inputs);
    // Env var name stays the real key; the lookup uses the (possibly sanitized) store name.
    for (const key of inputs.applySecretKeys) {
        expect(yaml).toContain(`${key}: \${{ secrets.${forgejoSecretName(key)} }}`);
    }
    expect(yaml).toContain(`FORGEJO_ADMIN_PASSWORD: \${{ secrets.INTENTIC_FORGEJO_ADMIN_PASSWORD }}`);
    expect(yaml).toContain("pnpm dlx @intentic/cli@1.2.3 deploy apply --yes --artifact desired-state.json $PREV");
    // The prune baseline rides the intentic-applied tag: an annotated tag's message is the baseline record apply wrote; a
    // plain tag from before that points at the applied artifact.
    expect(yaml).toContain("git tag -l --format='%(contents)' intentic-applied > /tmp/previous.json");
    expect(yaml).toContain("git show intentic-applied:desired-state.json > /tmp/previous.json");
    expect(yaml).toContain("tag -f -a --cleanup=verbatim -F .last-applied.json intentic-applied HEAD");
    // A tag that exists but cannot be read fails the step instead of reading as "no baseline".
    expect(yaml).toContain("set -e");
    // Tag push authenticates with the Forgejo admin password secret already in the apply env.
    expect(yaml).toContain("printf '%s:%s' 'intentic' \"$FORGEJO_ADMIN_PASSWORD\"");
});

// Workflows render from .eta templates; a stray space could produce a file that looks right but doesn't parse. Parses
// both as YAML and asserts the structure the runner depends on.
test("both rendered workflows are valid YAML with the expected job structure", () => {
    const intent = parse(intentWorkflowYaml(inputs)) as {
        on: { push: { branches: string[]; paths: string[] } };
        jobs: { resolve: { "runs-on": string; env: Record<string, string>; steps: unknown[] } };
    };
    expect(intent.on.push.branches).toEqual(["main"]);
    expect(intent.jobs.resolve["runs-on"]).toBe("docker");
    // Env block must nest under the job; a mis-indented entry would land at the wrong level.
    expect(intent.jobs.resolve.env["GIT_USER"]).toBe(`\${{ secrets.${GIT_USER_SECRET} }}`);
    expect(intent.jobs.resolve.env["CLOUDFLARE_API_TOKEN"]).toBe(`\${{ secrets.CLOUDFLARE_API_TOKEN }}`);

    const apply = parse(applyWorkflowYaml(inputs)) as {
        on: { push: { paths: string[] }; schedule: { cron: string }[] };
        jobs: Record<"apply" | "drift", { if: string; env: Record<string, string>; steps: { run?: string }[] }>;
    };
    expect(apply.on.push.paths).toEqual(["desired-state.json"]);
    // Every injected secret survived the loop at the right indentation, in both jobs.
    for (const key of inputs.applySecretKeys) {
        expect(apply.jobs.apply.env[key]).toBe(`\${{ secrets.${forgejoSecretName(key)} }}`);
        expect(apply.jobs.drift.env[key]).toBe(`\${{ secrets.${forgejoSecretName(key)} }}`);
    }
    expect(apply.jobs.apply.steps).toHaveLength(3);
});

// The scheduled reconcile: a push applies as before; once a day the drift job runs a plan that changes nothing and fails
// the run on drift, so the owner sees it in CI.
test("the apply workflow runs a daily drift check that never applies and fails on drift", () => {
    const workflow = parse(applyWorkflowYaml(inputs)) as {
        on: { schedule: { cron: string }[] };
        jobs: Record<"apply" | "drift", { if: string; steps: { run?: string }[] }>;
    };
    expect(workflow.on.schedule).toEqual([{ cron: "17 5 * * *" }]);
    expect(workflow.jobs.apply.if).toBe("github.event_name == 'push'");
    expect(workflow.jobs.drift.if).toBe("github.event_name == 'schedule'");
    const drift = workflow.jobs.drift.steps.map((step) => step.run ?? "").join("\n");
    expect(drift).toContain("pnpm dlx @intentic/cli@1.2.3 deploy plan --check --artifact desired-state.json $PREV");
    expect(drift).not.toContain("deploy apply");
    expect(drift).not.toContain("--yes");
    expect(drift).not.toContain("git tag -f");
});

test("setRepoSecrets PUTs each name/value onto the repo via the Forgejo API", async () => {
    const calls: { name: string; secretName: string; data: string }[] = [];
    const api = fakeForgejoApi({
        setRepoSecret: async ({ name, secretName, data }) => {
            calls.push({ name, secretName, data });
        },
    });
    await setRepoSecrets({
        api,
        baseUrl: "https://git.example.com",
        user: "intentic",
        password: "pw",
        owner: "intentic",
        name: "desired-state",
        secrets: { HOST_SSH_KEY: "key", FORGEJO_ADMIN_PASSWORD: "pw" },
    });

    // Reserved-prefix key is stored under its sanitized name; the value is unchanged.
    expect(calls).toEqual([
        { name: "desired-state", secretName: "HOST_SSH_KEY", data: "key" },
        { name: "desired-state", secretName: "INTENTIC_FORGEJO_ADMIN_PASSWORD", data: "pw" },
    ]);
});

test("forgejoSecretName prefixes reserved-prefix keys and passes the rest through", () => {
    expect(forgejoSecretName("FORGEJO_ADMIN_PASSWORD")).toBe("INTENTIC_FORGEJO_ADMIN_PASSWORD");
    expect(forgejoSecretName("GITHUB_TOKEN")).toBe("INTENTIC_GITHUB_TOKEN");
    expect(forgejoSecretName("GITEA_FOO")).toBe("INTENTIC_GITEA_FOO");
    expect(forgejoSecretName("KOMODO_ADMIN_PASSWORD")).toBe("KOMODO_ADMIN_PASSWORD");
    expect(forgejoSecretName("CLOUDFLARE_API_TOKEN")).toBe("CLOUDFLARE_API_TOKEN");
    expect(forgejoSecretName("INTENTIC_GIT_TOKEN")).toBe("INTENTIC_GIT_TOKEN");
});
