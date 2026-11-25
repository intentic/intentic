import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StackSpecInput } from "@intentic/sandbox-contract/schemas/deploys";
import { SETTLES, waitFor } from "@intentic/testing/bun";
import type { CiProject } from "../ci/projects.js";
import type { FetchFn } from "../ci/providers.js";
import { deployEnvironments } from "./deploy-environments.js";
import { environmentUrlOf } from "./deploy-forge.js";
import { stackMachine, stackRepo, watchFixture } from "./deploys.testing.js";

// Each deploy on its repository's forge (deploy-forge.ts), against real git, the fake computer and a forge this suite
// answers: GitHub's deployment and its statuses, GitLab's commit status, and a forge that refuses, which fails no deploy
// and is shown on the board.

let root: string;
let state: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "intentic-deploy-forge-work-"));
    state = await mkdtemp(join(tmpdir(), "intentic-deploy-forge-state-"));
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
});

const STAGING: StackSpecInput = { name: "staging", device: "rog", health: { http: ["http://127.0.0.1:8080/health", "https://staging.shop.example.com/health"] } };

const GITHUB: CiProject = {
    repo: "shop",
    project: "acme/shop",
    account: { provider: "github", host: "github.com", scheme: "https", apiBase: "https://api.github.com", token: "gh-token-T", httpsUser: "x-access-token" },
};
const GITLAB: CiProject = {
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

// A forge answering each call with `answer`, every call kept.
const forge = (answer: (call: ForgeCall) => Response = () => new Response(JSON.stringify({ id: 42 }), { status: 201 })) => {
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
    return { calls, fetchFn };
};

const boardOf = async (fixture: ReturnType<typeof watchFixture>) =>
    await deployEnvironments({
        root,
        device: fixture.deps.device,
        deviceCards: fixture.deps.deviceCards,
        records: fixture.engine.records,
        grants: fixture.engine.grants,
        stackState: fixture.engine.stackState,
        secretsChanged: fixture.engine.secretsChanged,
        forgeProblem: fixture.engine.forgeProblem,
    });

test("a stack answers on the origin of its first health URL that is not loopback", () => {
    expect(environmentUrlOf({ health: { timeoutSeconds: 60, http: ["http://127.0.0.1:8080/health", "https://shop.example.com/api/health"] } })).toBe("https://shop.example.com");
    expect(environmentUrlOf({ health: { timeoutSeconds: 60, http: ["http://localhost:3000/"] } })).toBeUndefined();
    expect(environmentUrlOf({ health: undefined })).toBeUndefined();
});

test("GitHub gets a deployment of the commit to the stack's environment, then in_progress and success, and the record keeps where it shows", async () => {
    const head = await stackRepo(root, "shop", [STAGING]);
    const { calls, fetchFn } = forge();
    const fixture = watchFixture(root, state, { tool: stackMachine(), projects: [GITHUB], fetch: fetchFn, publicUrl: "https://box.example.dev/" });

    const record = await fixture.engine.settled((await fixture.engine.enqueue({ repo: "shop", stack: "staging", trigger: { kind: "manual", detail: "by owner@example.com" } })).id);
    await waitFor(() => expect(calls).toHaveLength(3), SETTLES);
    const [kept] = await waitFor(async () => {
        const history = await fixture.engine.history({ repo: "shop", stack: "staging" });
        expect(history).toMatchObject([{ forgeUrl: "https://github.com/acme/shop/deployments/staging" }]);
        return history;
    }, SETTLES);

    expect(record.outcome).toBe("succeeded");
    expect(kept?.outcome).toBe("succeeded");
    const status = { environment_url: "https://staging.shop.example.com", log_url: "https://box.example.dev/ext/deployments?repo=shop&stack=staging" };
    expect(calls.map(({ url, method, body }) => ({ url, method, body }))).toEqual([
        {
            url: "https://api.github.com/repos/acme/shop/deployments",
            method: "POST",
            body: {
                ref: head,
                environment: "staging",
                description: "by owner@example.com",
                auto_merge: false,
                required_contexts: [],
                transient_environment: false,
                production_environment: false,
            },
        },
        { url: "https://api.github.com/repos/acme/shop/deployments/42/statuses", method: "POST", body: { state: "in_progress", description: `Deploying ${head.slice(0, 8)} by Intentic`, ...status } },
        { url: "https://api.github.com/repos/acme/shop/deployments/42/statuses", method: "POST", body: { state: "success", description: "Deploy succeeded", ...status } },
    ]);
    expect(calls[0]?.headers).toMatchObject({ authorization: "Bearer gh-token-T", "content-type": "application/json" });
});

test("a deploy that fails is a failure on GitHub, with the head of its error", async () => {
    await stackRepo(root, "shop", [{ ...STAGING, name: "production" }]);
    const { calls, fetchFn } = forge();
    const fixture = watchFixture(root, state, {
        tool: async (call) => (call.tool === "deploy_stack" ? { text: "web did not come up healthy in 60 s\nmore lines", refused: true } : await stackMachine()(call)),
        projects: [GITHUB],
        fetch: fetchFn,
    });

    const record = await fixture.engine.settled((await fixture.engine.enqueue({ repo: "shop", stack: "production", trigger: { kind: "manual" } })).id);
    await waitFor(() => expect(calls).toHaveLength(3), SETTLES);

    expect(record.outcome).toBe("failed");
    expect(calls.map(({ body }) => body)).toMatchObject([
        { environment: "production", production_environment: true },
        { state: "in_progress" },
        { state: "failure", description: "web did not come up healthy in 60 s" },
    ]);
});

test("GitLab gets a deploy/<stack> commit status, running then success", async () => {
    const head = await stackRepo(root, "shop", [{ name: "web", device: "rog" }]);
    const { calls, fetchFn } = forge(() => new Response("{}", { status: 201 }));
    const fixture = watchFixture(root, state, { tool: stackMachine(), projects: [GITLAB], fetch: fetchFn });

    await fixture.engine.settled((await fixture.engine.enqueue({ repo: "shop", stack: "web", trigger: { kind: "manual" } })).id);
    await waitFor(() => expect(calls).toHaveLength(2), SETTLES);
    await waitFor(async () => expect(await fixture.engine.history({ repo: "shop", stack: "web" })).toMatchObject([{ forgeUrl: `https://gitlab.example.com/acme/shop/-/commit/${head}` }]), SETTLES);

    const url = `https://gitlab.example.com/api/v4/projects/acme%2Fshop/statuses/${head}`;
    expect(calls.map(({ url: called, body }) => ({ called, body }))).toEqual([
        { called: url, body: { state: "running", name: "deploy/web", description: `Deploying ${head.slice(0, 8)} by Intentic`, ref: "main" } },
        { called: url, body: { state: "success", name: "deploy/web", description: "Deploy succeeded", ref: "main" } },
    ]);
    expect(calls[0]?.headers).toMatchObject({ "private-token": "gl-token-T" });
});

test("a forge that refuses fails no deploy: it is logged once per repository and shown on the board until a report works", async () => {
    await stackRepo(root, "shop", [STAGING]);
    let refusing = true;
    const { fetchFn } = forge(() =>
        refusing
            ? new Response(JSON.stringify({ message: "Resource not accessible by personal access token" }), { status: 403 })
            : new Response(JSON.stringify({ id: 7 }), { status: 201 }),
    );
    const fixture = watchFixture(root, state, { tool: stackMachine(), projects: [GITHUB], fetch: fetchFn });
    const problem = "GitHub refused this repository's deploy reports: give the GitHub token Deployments: write to see deploys on GitHub.";

    const first = await fixture.engine.settled((await fixture.engine.enqueue({ repo: "shop", stack: "staging", trigger: { kind: "manual" } })).id);
    const second = await fixture.engine.settled((await fixture.engine.enqueue({ repo: "shop", stack: "staging", trigger: { kind: "manual" } })).id);
    await waitFor(async () => expect((await boardOf(fixture)).environments).toMatchObject([{ stack: "staging", problems: [problem] }]), SETTLES);

    expect([first.outcome, second.outcome]).toEqual(["succeeded", "succeeded"]);
    expect(fixture.logged.filter((line) => String(line["message"]).startsWith("deploys: the forge was not told of a deploy"))).toHaveLength(1);
    refusing = false;
    await fixture.engine.settled((await fixture.engine.enqueue({ repo: "shop", stack: "staging", trigger: { kind: "manual" } })).id);
    await waitFor(async () => expect((await boardOf(fixture)).environments).toMatchObject([{ stack: "staging", problems: [] }]), SETTLES);
});
