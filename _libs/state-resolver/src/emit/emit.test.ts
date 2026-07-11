import { env, makeRef } from "@intentic/graph";
import type { CloudflareIntent, HostIntent, IntentSet } from "@intentic/need-resolver";
import { needKey, resolveNeeds } from "@intentic/need-resolver";
import { expect, test } from "vitest";
import type { Catalog } from "../lib/catalog.js";
import { forgejoCatalog, gitlabCatalog } from "../lib/catalog.js";
import { IMAGES } from "../lib/images.js";
import { DEFAULT_BACKUP_REPO } from "../resolvers/backup.js";
import type { Assignment } from "./emit.js";
import { emit } from "./emit.js";

// The authored inventory every test intent wires its apps to (on: "host", expose: "cf").
const host: HostIntent = { id: "host", input: { address: "203.0.113.10", user: "deploy", sshKey: env("HOST_SSH_KEY") } };
const cloudflare: CloudflareIntent = { id: "cf", input: { apiToken: env("CLOUDFLARE_API_TOKEN") } };

// The full single-combination assignment for an intent under the default catalog — the one combo emit
// supports today.
const assign = (intent: IntentSet, catalog: Catalog = forgejoCatalog): Assignment => {
    const byNeed = new Map<string, string>();
    for (const need of resolveNeeds(intent)) {
        const option = catalog.optionsFor(need.capability)[0];
        if (option === undefined) {
            throw new Error(`no option for ${need.capability}`);
        }
        byNeed.set(needKey(need), option.id);
    }
    return { byNeed };
};

test("emit derives the full support stack for a two-environment app", () => {
    const intent: IntentSet = {
        hosts: [host],
        cloudflare,
        users: [],
        teams: [],
        services: [],
        workspaces: [],
        backings: [],
        apps: [
            {
                id: "app",
                on: "host",
                expose: "cf",
                environments: {
                    staging: { domain: "staging.example.com", branch: "develop" },
                    production: { domain: "app.example.com", branch: "main" },
                },
            },
        ],
    };

    expect(emit(intent, assign(intent), "example.com").map((node) => node.id)).toEqual([
        "host",
        "cf",
        "host-git",
        "host-git-runner",
        "host-deploy",
        "cf-git-example-com",
        "cf-deploy-example-com",
        "app-repo",
        "app.staging-ci",
        "app.staging",
        "cf-staging-example-com",
        "app.production-ci",
        "app.production",
        "cf-app-example-com",
        "host-backup",
        "host-tunnel",
    ]);
});

test("apps share one derived platform", () => {
    const intent: IntentSet = {
        hosts: [host],
        cloudflare,
        users: [],
        teams: [],
        services: [],
        workspaces: [],
        backings: [],
        apps: [
            { id: "one", on: "host", expose: "cf", environments: { prod: { domain: "one.example.com", branch: "main" } } },
            { id: "two", on: "host", expose: "cf", environments: { prod: { domain: "two.example.com", branch: "main" } } },
        ],
    };

    const types = emit(intent, assign(intent), "example.com").map((node) => node.type);
    expect(types.filter((type) => type === "forgejo")).toHaveLength(1);
    expect(types.filter((type) => type === "komodo")).toHaveLength(1);
    // One tunnel for the shared host, across all apps.
    expect(types.filter((type) => type === "tunnel")).toHaveLength(1);
});

test("an unsupported option assignment throws", () => {
    const intent: IntentSet = {
        hosts: [host],
        cloudflare,
        users: [],
        teams: [],
        services: [],
        workspaces: [],
        backings: [],
        apps: [{ id: "app", on: "host", expose: "cf", environments: { prod: { domain: "app.example.com", branch: "main" } } }],
    };
    const byNeed = new Map(assign(intent).byNeed);
    byNeed.set("source-control:host", "bitbucket");
    expect(() => emit(intent, { byNeed }, "example.com")).toThrow('unsupported option "bitbucket"');
});

test("the GitLab stack derives gl-repo + one app-scoped gl-ci + per-env Komodo deployment, no forgejo", () => {
    const intent: IntentSet = {
        hosts: [host],
        cloudflare,
        gitlab: { id: "gl", input: { token: env("GITLAB_TOKEN") } },
        users: [],
        teams: [],
        services: [],
        workspaces: [],
        backings: [],
        apps: [
            {
                id: "app",
                on: "host",
                expose: "cf",
                environments: {
                    staging: { domain: "staging.example.com", branch: "develop" },
                    production: { domain: "app.example.com", branch: "main" },
                },
            },
        ],
    };

    const nodes = emit(intent, assign(intent, gitlabCatalog), "example.com");
    const byId = new Map(nodes.map((node) => [node.id, node]));

    // The GitLab inventory node carries the default instance url + the derived registry authority flows to gl-ci.
    expect(byId.get("gl")?.type).toBe("gitlab");
    expect(byId.get("gl")?.inputs["url"]).toBe("https://gitlab.com");

    // One project, ONE .gitlab-ci.yml for the whole app (both envs), and a Komodo deployment per env.
    expect(byId.get("app-repo")?.type).toBe("gl-repo");
    expect(byId.get("app-gl-ci")?.type).toBe("gl-ci");
    expect(nodes.filter((node) => node.type === "gl-ci")).toHaveLength(1);
    expect(byId.get("app.staging")?.type).toBe("deployment");
    expect(byId.get("app.production")?.type).toBe("deployment");
    expect(byId.get("app-gl-ci")?.inputs["registry"]).toBe("registry.gitlab.com");
    // The CI's notify step reaches Komodo through its PUBLIC url (hosted runners are external).
    expect(byId.get("app-gl-ci")?.inputs["komodoUrl"]).toEqual(makeRef("host-deploy", "url"));

    // Komodo is unconditional (the deploy orchestrator on every stack); Forgejo + its runner are not derived —
    // GitLab is the git/CI/registry. Komodo pulls from the GitLab registry with the account's PAT.
    const types = nodes.map((node) => node.type);
    expect(types).not.toContain("forgejo");
    expect(types).not.toContain("forgejo-runner");
    expect(types.filter((type) => type === "komodo")).toHaveLength(1);
    expect(byId.get("host-deploy")?.inputs["registry"]).toBe("registry.gitlab.com");
    expect(byId.get("host-deploy")?.inputs["registryUser"]).toEqual(makeRef("gl", "owner"));
    expect(byId.get("host-deploy")?.inputs["gitUrl"]).toBeUndefined();
    expect(byId.get("app.staging")?.inputs["registryAccount"]).toEqual(makeRef("gl", "owner"));
    // The host is never SSHed from CI: no host creds leave the graph toward the forge.
    expect(byId.get("app-gl-ci")?.inputs["hostSshKey"]).toBeUndefined();
});

test("a self-hosted GitLab url flows to the inventory node and a registry.<host> default", () => {
    const intent: IntentSet = {
        hosts: [host],
        cloudflare,
        gitlab: { id: "gl", input: { token: env("GITLAB_TOKEN"), url: "https://git.example.com" } },
        users: [],
        teams: [],
        services: [],
        workspaces: [],
        backings: [],
        apps: [{ id: "app", on: "host", expose: "cf", environments: { prod: { domain: "app.example.com", branch: "main" } } }],
    };

    const byId = new Map(emit(intent, assign(intent, gitlabCatalog), "example.com").map((node) => [node.id, node]));
    expect(byId.get("gl")?.inputs["url"]).toBe("https://git.example.com");
    expect(byId.get("app-gl-ci")?.inputs["registry"]).toBe("registry.git.example.com");
});

test("app with notify: discord derives forgejo-notify (CI) + komodo-notify (CD), wired to the discord node's webhooks", () => {
    const intent: IntentSet = {
        hosts: [host],
        cloudflare,
        discord: { id: "discord", input: { botToken: env("DISCORD_BOT_TOKEN") } },
        users: [],
        teams: [],
        services: [],
        workspaces: [],
        backings: [],
        apps: [
            {
                id: "app",
                on: "host",
                expose: "cf",
                notify: "discord",
                environments: { prod: { domain: "app.example.com", branch: "main" } },
            },
        ],
    };

    const nodes = emit(intent, assign(intent), "example.com");
    const forgejoNotify = nodes.find((node) => node.id === "app-repo-notify");
    const komodoNotify = nodes.find((node) => node.id === "app-notify");

    expect(forgejoNotify?.type).toBe("forgejo-notify");
    expect(forgejoNotify?.explicitDependsOn).toContain("discord");
    expect(komodoNotify?.type).toBe("komodo-notify");
    expect(komodoNotify?.explicitDependsOn).toContain("discord");

    // The webhook comes from the discord provider's per-app output, not a raw env secret.
    expect(forgejoNotify?.inputs["webhook"]).toEqual(makeRef("discord", "appWebhook:app"));
    expect(komodoNotify?.inputs["webhook"]).toEqual(makeRef("discord", "appWebhook:app"));
});

test("app without notify derives no notification sinks even when discord is declared", () => {
    const intent: IntentSet = {
        hosts: [host],
        cloudflare,
        discord: { id: "discord", input: { botToken: env("DISCORD_BOT_TOKEN") } },
        users: [],
        teams: [],
        services: [],
        workspaces: [],
        backings: [],
        apps: [{ id: "app", on: "host", expose: "cf", environments: { prod: { domain: "app.example.com", branch: "main" } } }],
    };

    const types = emit(intent, assign(intent), "example.com").map((node) => node.type);
    expect(types.filter((type) => type === "forgejo-notify")).toHaveLength(0);
    expect(types.filter((type) => type === "komodo-notify")).toHaveLength(0);
    // The discord node IS emitted but its apps list is empty (no app references it).
    expect(types.filter((type) => type === "discord")).toHaveLength(1);
    expect(emit(intent, assign(intent), "example.com").find((node) => node.type === "discord")?.inputs["apps"]).toEqual([]);
});

test("no discord declared derives no notification sinks", () => {
    const intent: IntentSet = {
        hosts: [host],
        cloudflare,
        users: [],
        teams: [],
        services: [],
        workspaces: [],
        backings: [],
        apps: [{ id: "app", on: "host", expose: "cf", environments: { prod: { domain: "app.example.com", branch: "main" } } }],
    };

    const types = emit(intent, assign(intent), "example.com").map((node) => node.type);
    expect(types.filter((type) => type === "forgejo-notify")).toHaveLength(0);
    expect(types.filter((type) => type === "komodo-notify")).toHaveLength(0);
    expect(types.filter((type) => type === "discord")).toHaveLength(0);
});

test("notification sinks are derived only for apps that wire notify, while the platform stays shared", () => {
    const intent: IntentSet = {
        hosts: [host],
        cloudflare,
        discord: { id: "discord", input: { botToken: env("DISCORD_BOT_TOKEN") } },
        users: [],
        teams: [],
        services: [],
        workspaces: [],
        backings: [],
        apps: [
            {
                id: "one",
                on: "host",
                expose: "cf",
                notify: "discord",
                environments: { prod: { domain: "one.example.com", branch: "main" } },
            },
            {
                id: "two",
                on: "host",
                expose: "cf",
                environments: { prod: { domain: "two.example.com", branch: "main" } },
            },
        ],
    };

    const types = emit(intent, assign(intent), "example.com").map((node) => node.type);
    // Only "one" wires notify — "two" opts out.
    expect(types.filter((type) => type === "forgejo-notify")).toHaveLength(1);
    expect(types.filter((type) => type === "komodo-notify")).toHaveLength(1);
    expect(types.filter((type) => type === "forgejo")).toHaveLength(1);
    expect(types.filter((type) => type === "komodo")).toHaveLength(1);
    expect(types.filter((type) => type === "discord")).toHaveLength(1);

    // The discord node carries only the notified app.
    const discordNode = emit(intent, assign(intent), "example.com").find((node) => node.type === "discord");
    expect(discordNode?.inputs["apps"]).toEqual(["one"]);
});

test("a services-only intent emits the service + its route + tunnel, but no app platform", () => {
    const intent: IntentSet = {
        hosts: [host],
        cloudflare,
        users: [],
        teams: [],
        services: [{ id: "obs", kind: "signoz", on: "host", expose: "cf", domain: "signoz.example.com" }],
        workspaces: [],
        backings: [],
        apps: [],
    };

    const nodes = emit(intent, assign(intent), "example.com");
    expect(nodes.map((node) => node.id)).toEqual(["host", "cf", "obs", "cf-signoz-example-com", "host-tunnel"]);
    const signoz = nodes.find((node) => node.id === "obs");
    expect(signoz?.type).toBe("signoz");
    expect(signoz?.inputs["domain"]).toBe("signoz.example.com");
    // The build platform exists only to ship apps from source — a services-only intent skips it.
    expect(nodes.some((node) => node.type === "forgejo")).toBe(false);
    expect(nodes.some((node) => node.type === "komodo")).toBe(false);
    // The service's dashboard port is aggregated onto the host tunnel's ingress.
    expect(nodes.find((node) => node.id === "host-tunnel")?.inputs["ingress"]).toEqual([{ hostname: "signoz.example.com", port: 8080 }]);
});

test("an app's observe injects the service's OTLP endpoint into each deployment and depends on the service", () => {
    const intent: IntentSet = {
        hosts: [host],
        cloudflare,
        users: [],
        teams: [],
        services: [{ id: "obs", kind: "signoz", on: "host", expose: "cf", domain: "signoz.example.com" }],
        workspaces: [],
        backings: [],
        apps: [
            {
                id: "app",
                on: "host",
                expose: "cf",
                observe: "obs",
                environments: { prod: { domain: "app.example.com", branch: "main", env: { DATABASE_URL: env("DB") } } },
            },
        ],
    };

    const deployment = emit(intent, assign(intent), "example.com").find((node) => node.id === "app.prod");
    // OTLP wiring is spread before the author's env, so an explicit DATABASE_URL survives alongside it.
    expect(deployment?.inputs["env"]).toEqual({
        OTEL_EXPORTER_OTLP_ENDPOINT: makeRef("obs", "otlpEndpoint"),
        OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
        DATABASE_URL: env("DB"),
    });
    expect(deployment?.explicitDependsOn).toContain("obs");
});

test("an app without observe carries no OTLP env and no service dependency", () => {
    const intent: IntentSet = {
        hosts: [host],
        cloudflare,
        users: [],
        teams: [],
        services: [],
        workspaces: [],
        backings: [],
        apps: [{ id: "app", on: "host", expose: "cf", environments: { prod: { domain: "app.example.com", branch: "main" } } }],
    };

    const deployment = emit(intent, assign(intent), "example.com").find((node) => node.id === "app.prod");
    expect(deployment?.inputs["env"]).toBeUndefined();
    expect(deployment?.explicitDependsOn).toEqual(["app.prod-ci", "cf-deploy-example-com"]);
});

test("observing an undeclared service throws", () => {
    const intent: IntentSet = {
        hosts: [host],
        cloudflare,
        users: [],
        teams: [],
        services: [],
        workspaces: [],
        backings: [],
        apps: [{ id: "app", on: "host", expose: "cf", observe: "ghost", environments: { prod: { domain: "app.example.com", branch: "main" } } }],
    };

    expect(() => emit(intent, assign(intent), "example.com")).toThrow('app "app" observes unknown service "ghost"');
});

test("users and teams derive Forgejo accounts + org/team and Komodo users, and the team owns the app's repo", () => {
    const intent: IntentSet = {
        hosts: [host],
        cloudflare,
        users: [{ id: "alice", input: { username: "alice", email: "alice@example.com" } }],
        teams: [{ id: "squad", input: { members: ["alice"], komodo: "execute" } }],
        services: [],
        workspaces: [],
        backings: [],
        apps: [
            {
                id: "app",
                on: "host",
                expose: "cf",
                teams: [{ team: "squad", role: "write" }],
                environments: { prod: { domain: "app.example.com", branch: "main" } },
            },
        ],
    };

    const nodes = emit(intent, assign(intent), "example.com");
    const byId = new Map(nodes.map((node) => [node.id, node]));

    // One identity node of each kind, host-scoped.
    expect(byId.get("host-git-user-alice")?.type).toBe("forgejo-user");
    expect(byId.get("host-deploy-user-alice")?.type).toBe("komodo-user");
    expect(byId.get("host-git-org-squad")?.type).toBe("forgejo-org");
    expect(byId.get("host-git-org-squad-team")?.type).toBe("forgejo-team");

    // The repo is owned by the team's org (its id), and so are the ci/deployment image namespaces.
    expect(byId.get("app-repo")?.inputs["owner"]).toBe("squad");
    expect(byId.get("app.prod")?.inputs["owner"]).toBe("squad");
    expect(byId.get("app-repo")?.explicitDependsOn).toContain("host-git-org-squad");

    // The team carries the resolved role + member usernames + the repos it is attached to.
    const team = byId.get("host-git-org-squad-team");
    expect(team?.inputs["permission"]).toBe("write");
    expect(team?.inputs["members"]).toEqual(["alice"]);
    expect(team?.inputs["repos"]).toEqual([{ owner: "squad", name: "app" }]);

    // The Komodo user is granted Execute on the app's deployment, and depends on it existing.
    const komodoUser = byId.get("host-deploy-user-alice");
    expect(komodoUser?.inputs["grants"]).toEqual([{ deployment: "app.prod", level: "Execute" }]);
    expect(komodoUser?.explicitDependsOn).toContain("app.prod");
});

test("a team-less app stays admin-owned (identical to the single-admin default)", () => {
    const intent: IntentSet = {
        hosts: [host],
        cloudflare,
        users: [],
        teams: [],
        services: [],
        workspaces: [],
        backings: [],
        apps: [{ id: "app", on: "host", expose: "cf", environments: { prod: { domain: "app.example.com", branch: "main" } } }],
    };

    const repo = emit(intent, assign(intent), "example.com").find((node) => node.id === "app-repo");
    expect(repo?.inputs["owner"]).toBe("intentic");
    expect(repo?.explicitDependsOn).toEqual(["host-git", "cf-git-example-com"]);
});

test("a team referencing an undeclared user throws", () => {
    const intent: IntentSet = {
        hosts: [host],
        cloudflare,
        users: [],
        teams: [{ id: "squad", input: { members: ["ghost"], komodo: "read" } }],
        services: [],
        workspaces: [],
        backings: [],
        apps: [
            {
                id: "app",
                on: "host",
                expose: "cf",
                teams: [{ team: "squad", role: "read" }],
                environments: { prod: { domain: "app.example.com", branch: "main" } },
            },
        ],
    };
    expect(() => emit(intent, assign(intent), "example.com")).toThrow('team "squad" references unknown user "ghost"');
});

test("an app granting an undeclared team throws", () => {
    const intent: IntentSet = {
        hosts: [host],
        cloudflare,
        users: [],
        teams: [],
        services: [],
        workspaces: [],
        backings: [],
        apps: [
            {
                id: "app",
                on: "host",
                expose: "cf",
                teams: [{ team: "ghost", role: "read" }],
                environments: { prod: { domain: "app.example.com", branch: "main" } },
            },
        ],
    };
    expect(() => emit(intent, assign(intent), "example.com")).toThrow('app "app" grants unknown team "ghost"');
});

test("the cloudflare node carries only token + discovered zone, and the tunnel reads the account from it via a ref", () => {
    const intent: IntentSet = {
        hosts: [host],
        cloudflare,
        users: [],
        teams: [],
        services: [],
        workspaces: [],
        backings: [],
        apps: [{ id: "app", on: "host", expose: "cf", environments: { prod: { domain: "app.example.com", branch: "main" } } }],
    };

    const nodes = emit(intent, assign(intent), "example.com");
    expect(nodes.find((node) => node.id === "cf")?.inputs).toEqual({ apiToken: env("CLOUDFLARE_API_TOKEN"), zone: "example.com" });
    // accountId is resolved by the cloudflare provider and read by the tunnel through a ref, never authored.
    expect(nodes.find((node) => node.id === "host-tunnel")?.inputs["accountId"]).toEqual(makeRef("cf", "accountId"));
});

// A minimal one-app intent reused by the guarded-update threading tests.
const oneApp: IntentSet["apps"][number] = {
    id: "app",
    on: "host",
    expose: "cf",
    environments: { production: { domain: "app.example.com", branch: "main" } },
};

test("a guarded host with a backup threads guardRepo + resticImage onto forgejo + komodo", () => {
    const intent: IntentSet = {
        hosts: [{ id: "host", input: { ...host.input, updatePolicy: "guarded" } }],
        cloudflare,
        backup: { id: "backups", input: { repo: "s3:s3.example.com/bucket", password: env("RESTIC_PASSWORD") } },
        users: [],
        teams: [],
        services: [],
        workspaces: [],
        backings: [],
        apps: [oneApp],
    };
    const nodes = emit(intent, assign(intent), "example.com");
    for (const id of ["host-git", "host-deploy"]) {
        const node = nodes.find((n) => n.id === id);
        expect(node?.inputs["guardRepo"], id).toBe("s3:s3.example.com/bucket");
        expect(typeof node?.inputs["resticImage"], id).toBe("string");
    }
    expect(nodes.some((n) => n.id === "host-backup")).toBe(true);
});

test("a pinned host (default) leaves the guard inputs off even when a backup is declared", () => {
    const intent: IntentSet = {
        hosts: [host],
        cloudflare,
        backup: { id: "backups", input: { repo: "s3:s3.example.com/bucket", password: env("RESTIC_PASSWORD") } },
        users: [],
        teams: [],
        services: [],
        workspaces: [],
        backings: [],
        apps: [oneApp],
    };
    const nodes = emit(intent, assign(intent), "example.com");
    expect(nodes.find((n) => n.id === "host-git")?.inputs["guardRepo"]).toBeUndefined();
});

test("a guarded host WITHOUT a declared backup guards against the default on-host repo (restic is on-by-default)", () => {
    const intent: IntentSet = {
        hosts: [{ id: "host", input: { ...host.input, updatePolicy: "guarded" } }],
        cloudflare,
        users: [],
        teams: [],
        services: [],
        workspaces: [],
        backings: [],
        apps: [oneApp],
    };
    const nodes = emit(intent, assign(intent), "example.com");
    expect(nodes.find((n) => n.id === "host-git")?.inputs["guardRepo"]).toBe(DEFAULT_BACKUP_REPO);
});

test("a workspace-only intent emits the sandbox node + its wildcard preview route + tunnel, no app platform", () => {
    const intent: IntentSet = {
        hosts: [host],
        cloudflare,
        users: [],
        teams: [],
        services: [],
        workspaces: [{ id: "workspace", on: "host", expose: "cf" }],
        backings: [],
        apps: [],
    };

    const nodes = emit(intent, assign(intent), "example.com");
    const sandbox = nodes.find((node) => node.id === "workspace");
    expect(sandbox?.type).toBe("workspace");
    // The workspace IS the sandbox image now (no runner); the daemon + preview proxy ports are resolver constants.
    expect(sandbox?.inputs["image"]).toBe(IMAGES.sandbox);
    expect(sandbox?.inputs["domain"]).toBe("*.example.com");
    expect(sandbox?.inputs["network"]).toBe("intentic-workspace");
    expect(sandbox?.inputs["previewPort"]).toBe(5173);
    expect(sandbox?.inputs["daemonPort"]).toBe(8787);
    // No app platform for a workspace-only intent.
    expect(nodes.some((node) => node.type === "forgejo")).toBe(false);
    expect(nodes.some((node) => node.type === "komodo")).toBe(false);
    // The wildcard hostname flows unchanged into the cf-route (id slugged) and routes to the sandbox's preview
    // proxy on the host tunnel's ingress (the daemon stays host-internal — preview-only).
    expect(nodes.find((node) => node.type === "cf-route")?.inputs["hostname"]).toBe("*.example.com");
    expect(nodes.find((node) => node.id === "host-tunnel")?.inputs["ingress"]).toEqual([{ hostname: "*.example.com", port: 5173 }]);
});

test("a workspace exposing a service wires it as an MCP tool (domain URL + generated scoped token)", () => {
    const intent: IntentSet = {
        hosts: [host],
        cloudflare,
        users: [],
        teams: [],
        services: [{ id: "obs", kind: "signoz", on: "host", expose: "cf", domain: "signoz.example.com" }],
        workspaces: [{ id: "workspace", on: "host", expose: "cf", tools: ["obs"] }],
        backings: [],
        apps: [],
    };

    const sandbox = emit(intent, assign(intent), "example.com").find((node) => node.id === "workspace");
    // The tool is addressed by its routed domain (works cross-host), with an intentic-generated bearer (raw
    // SecretRef here — the $secret form is the compiled shape). The token key is shared with the tool itself.
    expect(sandbox?.inputs["tools"]).toEqual([
        { name: "obs", url: "https://signoz.example.com/mcp", token: { kind: "secret", source: "generated", key: "SIGNOZ_MCP_TOKEN" } },
    ]);
});

test("a workspace without tools emits no tools input (preview-only sandboxes are unchanged)", () => {
    const intent: IntentSet = {
        hosts: [host],
        cloudflare,
        users: [],
        teams: [],
        services: [],
        workspaces: [{ id: "workspace", on: "host", expose: "cf" }],
        backings: [],
        apps: [],
    };
    expect(emit(intent, assign(intent), "example.com").find((node) => node.id === "workspace")?.inputs["tools"]).toBeUndefined();
});

test('a host with via:"cloudflared" threads the transport onto every node deployed to it over SSH', () => {
    const intent: IntentSet = {
        hosts: [{ id: "host", input: { ...host.input, via: "cloudflared" } }],
        cloudflare,
        users: [],
        teams: [],
        services: [],
        workspaces: [],
        backings: [],
        apps: [oneApp],
    };
    const nodes = emit(intent, assign(intent), "example.com");
    // Every SSH-deploying node — not just the host — must carry via, so the executor tunnels to a NAT'd self
    // host for the control plane, its runner, the backup job, and the tunnel connector alike.
    for (const id of ["host", "host-git", "host-git-runner", "host-deploy", "host-backup", "host-tunnel"]) {
        expect(nodes.find((node) => node.id === id)?.inputs["via"], id).toBe("cloudflared");
    }
});

test("a host left at the default transport emits no via (the provider defaults it to direct)", () => {
    const intent: IntentSet = {
        hosts: [host],
        cloudflare,
        users: [],
        teams: [],
        services: [],
        workspaces: [],
        backings: [],
        apps: [oneApp],
    };
    const nodes = emit(intent, assign(intent), "example.com");
    expect(nodes.find((node) => node.id === "host")?.inputs["via"]).toBeUndefined();
    expect(nodes.find((node) => node.id === "host-tunnel")?.inputs["via"]).toBeUndefined();
});

test("an outline service emits its dashboard route AND a first-level <sub>-auth.<zone> route for the bundled Dex", () => {
    const intent: IntentSet = {
        hosts: [host],
        cloudflare,
        users: [],
        teams: [],
        services: [{ id: "wiki", kind: "outline", on: "host", expose: "cf", domain: "wiki.example.com" }],
        workspaces: [],
        backings: [],
        apps: [],
    };

    const nodes = emit(intent, assign(intent), "example.com");
    expect(nodes.map((node) => node.id)).toEqual(["host", "cf", "wiki", "cf-wiki-example-com", "cf-wiki-auth-example-com", "host-tunnel"]);
    const wiki = nodes.find((node) => node.id === "wiki");
    expect(wiki?.type).toBe("outline");
    expect(wiki?.inputs["authDomain"]).toBe("wiki-auth.example.com");
    // The password secret key is per-kind, and the images come from the catalog's pins.
    expect(wiki?.inputs["adminPassword"]).toEqual({ kind: "secret", source: "generated", key: "OUTLINE_ADMIN_PASSWORD" });
    expect(wiki?.inputs["adminUser"]).toBe("intentic@example.com");
    expect(wiki?.inputs["dexImage"]).toBe(IMAGES.dex);
    // Both hostnames land on the host tunnel's ingress: the dashboard and the Dex login.
    expect(nodes.find((node) => node.id === "host-tunnel")?.inputs["ingress"]).toEqual([
        { hostname: "wiki.example.com", port: 3210 },
        { hostname: "wiki-auth.example.com", port: 5556 },
    ]);
});

test("an openproject service logs in with the fixed admin username, not the email convention", () => {
    const intent: IntentSet = {
        hosts: [host],
        cloudflare,
        users: [],
        teams: [],
        services: [{ id: "pm", kind: "openproject", on: "host", expose: "cf", domain: "pm.example.com" }],
        workspaces: [],
        backings: [],
        apps: [],
    };

    const pm = emit(intent, assign(intent), "example.com").find((node) => node.id === "pm");
    expect(pm?.inputs["adminUser"]).toBe("admin");
    expect(pm?.inputs["adminPassword"]).toEqual({ kind: "secret", source: "generated", key: "OPENPROJECT_ADMIN_PASSWORD" });
    expect(pm?.inputs["authDomain"]).toBeUndefined();
});

test("observing a non-signoz service is rejected (only signoz produces an otlpEndpoint)", () => {
    const intent: IntentSet = {
        hosts: [host],
        cloudflare,
        users: [],
        teams: [],
        services: [{ id: "wiki", kind: "outline", on: "host", expose: "cf", domain: "wiki.example.com" }],
        workspaces: [],
        backings: [],
        apps: [{ id: "app", on: "host", expose: "cf", observe: "wiki", environments: { prod: { domain: "app.example.com", branch: "main" } } }],
    };

    expect(() => emit(intent, assign(intent), "example.com")).toThrow(/not a signoz service/);
});
