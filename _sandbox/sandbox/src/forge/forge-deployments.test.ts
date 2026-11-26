import type { CiDeploymentReport } from "@intentic/sandbox-contract/schemas/ci";
import { forgeClientFor } from "./client.js";
import { CiRateLimited } from "./refusals.js";
import type { ForgeProject } from "./projects.js";
import type { FetchFn } from "./http.js";
import { type DeploymentReportDeps, reportDeployment } from "./forge-deployments.js";

// A deployment told to the repository's forge (forge-deployments.ts), against a forge this suite answers: GitHub's
// deployment and its statuses, GitLab's commit status, and each refusal in the forge's own words.

const SHA = "0123456789abcdef0123456789abcdef01234567";

const GITHUB: ForgeProject = {
    repo: "shop",
    project: "acme/shop",
    account: { provider: "github", host: "github.com", scheme: "https", apiBase: "https://api.github.com", token: "gh-token-T", httpsUser: "x-access-token" },
};
const GITLAB: ForgeProject = {
    repo: "shop",
    project: "acme/shop",
    account: { provider: "gitlab", host: "gitlab.example.com", scheme: "https", apiBase: "https://gitlab.example.com/api/v4", token: "gl-token-T", httpsUser: "oauth2" },
};

interface ForgeCall {
    readonly url: string;
    readonly method: string | undefined;
    readonly body: unknown;
    readonly headers: Readonly<Record<string, string>>;
}

// A forge answering each call with `answer`, every call kept, for the repository's one project.
const forge = (project: ForgeProject | undefined, answer: (call: ForgeCall) => Response = () => new Response(JSON.stringify({ id: 42 }), { status: 201 })) => {
    const calls: ForgeCall[] = [];
    const fetchFn: FetchFn = async (input, init) => {
        const call: ForgeCall = {
            url: String(input),
            method: init?.method,
            // Every report posts JSON text.
            body: JSON.parse(String(init?.body ?? "null")),
            headers: Object.fromEntries(new Headers(init?.headers).entries()),
        };
        calls.push(call);
        return answer(call);
    };
    const deps: DeploymentReportDeps = { projectOf: async (repo) => (repo === project?.repo ? project : undefined), fetch: fetchFn };
    return { calls, deps };
};

const REPORT: CiDeploymentReport = {
    repo: "shop",
    sha: SHA,
    environment: "staging",
    state: "in_progress",
    production: false,
    description: "Deploying 01234567 by Intentic",
    environmentUrl: "https://staging.shop.example.com",
    logUrl: "https://box.example.dev/ext/deployments?repo=shop&stack=staging",
};

test("GitHub gets a deployment of the commit to the environment and its first status, and the answer carries its id", async () => {
    const { calls, deps } = forge(GITHUB);

    expect(await reportDeployment(deps, REPORT)).toEqual({ deploymentId: 42, url: "https://github.com/acme/shop/deployments/staging" });

    const status = { environment_url: "https://staging.shop.example.com", log_url: "https://box.example.dev/ext/deployments?repo=shop&stack=staging" };
    expect(calls.map(({ url, method, body }) => ({ url, method, body }))).toEqual([
        {
            url: "https://api.github.com/repos/acme/shop/deployments",
            method: "POST",
            body: {
                ref: SHA,
                environment: "staging",
                description: "Deploying 01234567 by Intentic",
                auto_merge: false,
                required_contexts: [],
                transient_environment: false,
                production_environment: false,
            },
        },
        { url: "https://api.github.com/repos/acme/shop/deployments/42/statuses", method: "POST", body: { state: "in_progress", description: "Deploying 01234567 by Intentic", ...status } },
    ]);
    expect(calls[0]?.headers).toMatchObject({ authorization: "Bearer gh-token-T", "content-type": "application/json" });
});

test("a later state on GitHub goes to the deployment it names, and creates none", async () => {
    const { calls, deps } = forge(GITHUB);
    expect(await reportDeployment(deps, { ...REPORT, state: "failure", description: "web did not come up healthy in 60 s", deploymentId: 42 })).toEqual({
        deploymentId: 42,
        url: "https://github.com/acme/shop/deployments/staging",
    });
    expect(calls.map(({ url, body }) => ({ url, body }))).toEqual([
        {
            url: "https://api.github.com/repos/acme/shop/deployments/42/statuses",
            body: {
                state: "failure",
                description: "web did not come up healthy in 60 s",
                environment_url: "https://staging.shop.example.com",
                log_url: "https://box.example.dev/ext/deployments?repo=shop&stack=staging",
            },
        },
    ]);
});

test("GitLab gets a deploy/<environment> commit status in its own words for each state", async () => {
    const { calls, deps } = forge(GITLAB, () => new Response("{}", { status: 201 }));
    expect(await reportDeployment(deps, REPORT)).toEqual({ url: `https://gitlab.example.com/acme/shop/-/commit/${SHA}` });
    await reportDeployment(deps, { ...REPORT, state: "inactive", description: undefined });

    const url = `https://gitlab.example.com/api/v4/projects/acme%2Fshop/statuses/${SHA}`;
    expect(calls.map(({ url: called, body }) => ({ called, body }))).toEqual([
        {
            called: url,
            body: { state: "running", name: "deploy/staging", description: "Deploying 01234567 by Intentic", target_url: "https://box.example.dev/ext/deployments?repo=shop&stack=staging" },
        },
        { called: url, body: { state: "canceled", name: "deploy/staging", target_url: "https://box.example.dev/ext/deployments?repo=shop&stack=staging" } },
    ]);
    expect(calls[0]?.headers).toMatchObject({ "private-token": "gl-token-T" });
});

test("a token the forge refuses is FORBIDDEN in the forge's words, saying what to give it; any other refusal is the forge's", async () => {
    const scoped = forge(GITHUB, () => new Response(JSON.stringify({ message: "Resource not accessible by personal access token" }), { status: 403 }));
    await expect(reportDeployment(scoped.deps, REPORT)).rejects.toMatchObject({
        code: "FORBIDDEN",
        message:
            "GitHub refused creating a deployment of staging (403): Resource not accessible by personal access token. Give the GitHub token Deployments: write to see deploys there.",
    });
    const unknown = forge(GITLAB, () => new Response(JSON.stringify({ message: "Cannot transition status via :run from :running" }), { status: 400 }));
    await expect(reportDeployment(unknown.deps, REPORT)).rejects.toMatchObject({
        code: "BAD_GATEWAY",
        message: "GitLab refused a commit status (400): Cannot transition status via :run from :running",
    });
});

test("a repository no connected forge account maps is refused before anything is sent", async () => {
    const { calls, deps } = forge(undefined);
    await expect(reportDeployment(deps, REPORT)).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        message: `"shop" has no remote on a connected GitHub or GitLab account: connect the one it is pushed to (Capabilities), and its deploys show there.`,
    });
    expect(calls).toEqual([]);
});

test("a CI cooldown still allows deployments and repository creation on the same account", async () => {
    const { deps, calls } = forge(GITHUB, ({ url }) => {
        if (url.endsWith("/user/repos")) {
            return Response.json({ clone_url: "https://github.com/acme/new.git" });
        }
        return url.endsWith("/statuses") ? Response.json({}) : new Response("slow down", { status: 429, headers: { "retry-after": "60" } });
    });
    const client = forgeClientFor("github", deps.fetch);
    await expect(client.listRuns(GITHUB, 1)).rejects.toBeInstanceOf(CiRateLimited);
    expect(await reportDeployment(deps, { ...REPORT, deploymentId: 42 })).toEqual({
        deploymentId: 42,
        url: "https://github.com/acme/shop/deployments/staging",
    });
    expect(await client.createRepository(GITHUB.account, "new", undefined, () => {})).toBe("https://github.com/acme/new.git");
    await expect(client.listRuns(GITHUB, 1)).rejects.toBeInstanceOf(CiRateLimited);
    expect(calls.map(({ url }) => url)).toEqual([
        "https://api.github.com/repos/acme/shop/actions/runs?per_page=1",
        "https://api.github.com/repos/acme/shop/deployments/42/statuses",
        "https://api.github.com/user/repos",
    ]);
});
