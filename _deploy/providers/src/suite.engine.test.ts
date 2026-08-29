import { apply } from "@intentic/engine";
import { env } from "@intentic/graph";
import { defineStack } from "@intentic/sdk";
import { expect, test } from "vitest";
import { unstubbed } from "@intentic/testing";
import type { SshExecutor, SshResult } from "./core/ssh.js";
import type { ForgejoApi, ForgejoHook, ForgejoRepo } from "./forgejo/forgejo-api.js";
import type { GitLabApi } from "./gitlab/gitlab-api.js";
import type { AlerterConfig, DeploymentConfig, KomodoApi } from "./komodo/komodo-api.js";
import type { CloudflareApi, IngressRule } from "./network/cloudflare-api.js";
import { createProviders } from "./providers.js";

// Parse a compose YAML literal into a service -> image map, mirroring the providers' `{{.Config.Image}}`
// observation: each `  <service>:` header followed by an `    image: <ref>` line.
const serviceImages = (yaml: string): Record<string, string> => {
    const images: Record<string, string> = {};
    let service: string | undefined;
    for (const line of yaml.split("\n")) {
        const header = /^ {2}([\w-]+):\s*$/.exec(line);
        if (header?.[1] !== undefined) {
            service = header[1];
            continue;
        }
        const image = /^ {4}image:\s*(\S+)/.exec(line);
        if (image?.[1] !== undefined && service !== undefined) {
            images[service] = image[1];
        }
    }
    return images;
};

const ok = (stdout = "", code = 0): SshResult => ({ stdout, stderr: "", code });

/* Read a `--label intentic.<key>=<value>` back out of an emitted docker command the way the host's shell hands
 * it to docker, rather than by matching one quoting style. The provider shell-quotes its arguments, so a value
 * with a space arrives single-quoted and a plain one arrives bare: a fake that only understood `"…"` reported
 * an empty schedule, and the diff then wanted to recreate a container that was already correct. */
const labelValue = (command: string, key: string): string | undefined => {
    const quoted = new RegExp(`--label '(?:intentic\\.${key}=)([^']*)'`).exec(command);
    return quoted?.[1] ?? new RegExp(`--label (?:intentic\\.${key}=)(\\S*)`).exec(command)?.[1];
};

// A stateful host shared by host/forgejo/forgejo-runner/komodo/tunnel/signoz: Docker-ready, default route ->
// 10.0.0.5, and it remembers which containers have been started (and on which image) so a second apply reads
// them as running on the desired pin: exercising the image-drift diff's idempotency.
const fakeSsh = (): SshExecutor => {
    const started = new Set<string>();
    const containerImages = new Map<string, string>();
    const containerLabels = new Map<string, { schedule: string; repo: string }>();
    const files = new Map<string, string>();
    let tokenPersisted = false;
    let gitTokenPersisted = false;
    let packagesTokenPersisted = false;
    return {
        connect: async () => ({
            exec: async (command): Promise<SshResult> => {
                if (command.includes("docker version")) {
                    return ok("24.0.0");
                }
                if (command.includes("ip -4 -o route")) {
                    return ok("10.0.0.5\n");
                }
                // Capture every heredoc-written file (compose.yaml, config.toml, runner config.yaml, ...).
                const write = /cat > (\S+) <<'(\w+)'\n([\s\S]*)\2/.exec(command);
                if (write?.[1] !== undefined && write[3] !== undefined) {
                    files.set(write[1], write[3]);
                    return ok();
                }
                if (command.includes("generate-runner-token")) {
                    tokenPersisted = true;
                    return ok("rtok");
                }
                if (command.includes("generate-access-token")) {
                    if (command.includes("write:package")) {
                        packagesTokenPersisted = true;
                        return ok("ptok");
                    }
                    gitTokenPersisted = true;
                    return ok("gtok");
                }
                if (command.includes("command -v docker")) {
                    return ok("/usr/local/bin/docker");
                }
                if (command.includes("docker-buildx")) {
                    return ok("/usr/local/libexec/docker/cli-plugins/docker-buildx");
                }
                // Compose-project image inspect (komodo/signoz): report each running service's image from the
                // compose file the provider wrote.
                const project = /com\.docker\.compose\.project=(\w+)/.exec(command);
                if (project?.[1] !== undefined) {
                    if (!started.has(`intentic-${project[1]}`)) {
                        return ok("");
                    }
                    const images = serviceImages(files.get(`/opt/intentic/${project[1]}/compose.yaml`) ?? "");
                    return ok(
                        Object.entries(images)
                            .map(([service, image]) => `${service}=${image}`)
                            .join("\n"),
                    );
                }
                // Backup observe: the multi-field inspect (image|schedule|repo) from the container's create-time
                // labels: distinct from the single-image inspect below, so match it first.
                const backupInspect = /docker inspect --format '[^']*intentic\.schedule[^']*' (\S+)/.exec(command);
                if (backupInspect?.[1] !== undefined) {
                    const name = backupInspect[1];
                    if (!started.has(name)) {
                        return ok("");
                    }
                    const labels = containerLabels.get(name);
                    return ok(`${containerImages.get(name) ?? ""}|${labels?.schedule ?? ""}|${labels?.repo ?? ""}`);
                }
                // Single-container image inspect (forgejo/forgejo-runner/tunnel).
                const inspect = /docker inspect --format '\{\{\.Config\.Image\}\}' (\S+)/.exec(command);
                if (inspect?.[1] !== undefined) {
                    return ok(containerImages.get(inspect[1]) ?? "");
                }
                const label = /docker ps --filter "label=intentic.id=([^"]+)"/.exec(command);
                if (label?.[1] !== undefined) {
                    return ok(started.has(label[1]) ? "komodo-core-1" : "");
                }
                const ps = /docker ps --filter "name=\^([^$]+)\$"/.exec(command);
                if (ps?.[1] !== undefined) {
                    return ok(started.has(ps[1]) ? ps[1] : "");
                }
                const run = /docker run .*--name (\S+)/.exec(command);
                if (run?.[1] !== undefined) {
                    started.add(run[1]);
                    const image = /(\S+@sha256:[0-9a-f]+)/.exec(command);
                    if (image?.[1] !== undefined) {
                        containerImages.set(run[1], image[1]);
                    }
                    // The backup container carries its schedule/repo as create-time labels (what its observe reads back).
                    const schedule = labelValue(command, "schedule");
                    const repo = labelValue(command, "repo");
                    if (schedule !== undefined && repo !== undefined) {
                        containerLabels.set(run[1], { schedule, repo });
                    }
                    return ok("cid");
                }
                if (command.includes("docker compose") && command.includes("up -d")) {
                    const proj = /docker compose -p (\w+)/.exec(command);
                    if (proj?.[1] !== undefined) {
                        started.add(`intentic-${proj[1]}`);
                        // Containers carry the intentic.id stamps written into the project's compose.yaml:
                        // mark each as started, which is what the label-based running() checks match.
                        const file = /-f (\S+\/compose\.yaml)/.exec(command);
                        const content = file?.[1] !== undefined ? (files.get(file[1]) ?? "") : "";
                        for (const match of content.matchAll(/intentic\.id=([^"\s,\]]+)/g)) {
                            if (match[1] !== undefined) {
                                started.add(match[1]);
                            }
                        }
                    }
                    return ok("up");
                }
                if (command.includes("wget -q --spider")) {
                    return ok("", started.has("intentic-forgejo") ? 0 : 1);
                }
                if (command.includes("cat /data/.runner")) {
                    return ok(started.has("intentic-forgejo-runner") ? "http://10.0.0.5:3000" : "");
                }
                // Runner config read (configuredJobImage): return the file the provider wrote.
                const read = /cat (\/\S+) 2>\/dev\/null/.exec(command);
                if (read?.[1] !== undefined && files.has(read[1])) {
                    return ok(files.get(read[1]));
                }
                if (command.includes("packages-token")) {
                    return ok(packagesTokenPersisted ? "ptok" : "");
                }
                if (command.includes("git-token")) {
                    return ok(gitTokenPersisted ? "gtok" : "");
                }
                if (command.includes("runner-token")) {
                    return ok(tokenPersisted ? "rtok" : "");
                }
                return ok();
            },
            dispose: async () => {},
            // The control-plane API providers (repo/ci/deployment/…) reach their service over a loopback
            // forward; the fake apis ignore the authority, so any fixed port serves.
            forward: async () => ({ port: 9999, close: async () => {} }),
        }),
    };
};

const fakeCloudflare = (): CloudflareApi => {
    const tunnels = new Map<string, string>();
    const records = new Map<string, { id: string; content: string }>();
    let ingress: IngressRule[] | undefined;
    let seq = 0;
    // `satisfies` keeps the literal contextually typed (so each method's args are inferred and checked)
    // while `unstubbed` supplies the rest of the interface: this fake models the calls the engine drives.
    const modelled = {
        getZone: async () => ({ id: "zone-123", accountId: "acct-1" }),
        listZones: async () => [{ id: "zone-123", name: "example.com", accountId: "acct-1" }],
        findTunnel: async ({ name }) => {
            const id = tunnels.get(name);
            return id === undefined ? undefined : { id };
        },
        createTunnel: async ({ name }) => {
            const id = `tunnel-${seq++}`;
            tunnels.set(name, id);
            return { id };
        },
        getTunnelToken: async () => "connector-token",
        getTunnelStatus: async () => "healthy",
        getTunnelIngress: async () => ingress,
        putTunnelIngress: async ({ ingress: next }) => {
            ingress = [...next];
        },
        findDnsRecord: async ({ name }) => records.get(name),
        createDnsRecord: async ({ name, content }) => {
            records.set(name, { id: `rec-${seq++}`, content });
        },
        updateDnsRecord: async ({ name, content, recordId }) => {
            records.set(name, { id: recordId, content });
        },
        deleteTunnel: async () => {},
        deleteDnsRecord: async () => {},
    } satisfies Partial<CloudflareApi>;
    return unstubbed("cloudflare", modelled);
};

const fakeForgejoApi = (): ForgejoApi => {
    const repos = new Map<string, ForgejoRepo>();
    const hooks = new Map<string, ForgejoHook[]>();
    const files = new Map<string, string>();
    let seq = 0;
    // `satisfies` keeps the literal contextually typed (so each method's args are inferred and checked)
    // while `unstubbed` supplies the rest of the interface: this fake models the calls the engine drives.
    const modelled = {
        findRepo: async ({ name }) => repos.get(name),
        createRepo: async ({ name }) => {
            const repo = { cloneUrl: `https://git.example.com/admin/${name}.git`, sshUrl: `git@git.example.com:admin/${name}.git` };
            repos.set(name, repo);
            return repo;
        },
        listHooks: async ({ name }) => hooks.get(name) ?? [],
        createHook: async ({ name, type, config, events }) => {
            const list = hooks.get(name) ?? [];
            list.push({ id: seq++, type, config, events: [...events], active: true });
            hooks.set(name, list);
        },
        updateHook: async ({ name, id, config, events }) => {
            hooks.set(
                name,
                (hooks.get(name) ?? []).map((hook) =>
                    hook.id === id ? { id: hook.id, type: hook.type, config, events: [...events], active: hook.active } : hook,
                ),
            );
        },
        latestCommit: async ({ name, branch }) => (files.has(`${name}@${branch}`) ? `sha-${name}-${branch}` : undefined),
        readFile: async ({ name, branch, path }) => files.get(`${name}@${branch}:${path}`),
        commitFile: async ({ name, branch, path, content }) => {
            files.set(`${name}@${branch}`, "");
            files.set(`${name}@${branch}:${path}`, content);
        },
        setRepoSecret: async () => {},
    } satisfies Partial<ForgejoApi>;
    return unstubbed("forgejo", modelled);
};

const fakeGitlabApi = (): GitLabApi => {
    const projects = new Set<string>();
    const files = new Map<string, string>();
    return {
        getAuthenticatedUser: async () => ({ username: "intentic" }),
        findProject: async ({ owner, name }) =>
            projects.has(name)
                ? { httpUrlToRepo: `https://gitlab.com/${owner}/${name}.git`, sshUrlToRepo: `git@gitlab.com:${owner}/${name}.git` }
                : undefined,
        createProject: async ({ name }) => {
            projects.add(name);
        },
        deleteProject: async ({ name }) => {
            projects.delete(name);
        },
        readFile: async ({ name, branch, path }) => {
            const content = files.get(`${name}@${branch}:${path}`);
            return content === undefined ? undefined : { content };
        },
        commitFile: async ({ name, branch, path, content }) => {
            files.set(`${name}@${branch}:${path}`, content);
        },
        deleteFile: async ({ name, branch, path }) => {
            files.delete(`${name}@${branch}:${path}`);
        },
        setCiVariable: async () => {},
        deleteCiVariable: async () => {},
    };
};

const fakeKomodoApi = (): KomodoApi => {
    const deployments = new Map<string, { id: string; config: DeploymentConfig }>();
    const alerters = new Map<string, { id: string; config: AlerterConfig }>();
    let seq = 0;
    // `satisfies` keeps the literal contextually typed (so each method's args are inferred and checked)
    // while `unstubbed` supplies the rest of the interface: this fake models the calls the engine drives.
    const modelled = {
        login: async () => "jwt",
        listDeployments: async () => [...deployments].map(([name, value]) => ({ id: value.id, name })),
        getDeployment: async ({ deployment }) => {
            const value = deployments.get(deployment);
            if (value === undefined) {
                throw new Error(`no deployment ${deployment}`);
            }
            return value.config;
        },
        createDeployment: async ({ name, config }) => {
            deployments.set(name, { id: `d-${seq++}`, config: config as DeploymentConfig });
        },
        updateDeployment: async ({ id, config }) => {
            for (const [name, value] of deployments) {
                if (value.id === id) {
                    deployments.set(name, { id, config: config as DeploymentConfig });
                }
            }
        },
        listAlerters: async () => [...alerters].map(([name, value]) => ({ id: value.id, name })),
        getAlerter: async ({ id }) => {
            for (const value of alerters.values()) {
                if (value.id === id) {
                    return value.config;
                }
            }
            throw new Error(`no alerter ${id}`);
        },
        createAlerter: async ({ name, config }) => {
            alerters.set(name, { id: `a-${seq++}`, config });
        },
        updateAlerter: async ({ id, config }) => {
            for (const [name, value] of alerters) {
                if (value.id === id) {
                    alerters.set(name, { id, config });
                }
            }
        },
    } satisfies Partial<KomodoApi>;
    return unstubbed("komodo", modelled);
};

const fullEnv = {
    HOST_SSH_KEY: "k",
    CLOUDFLARE_API_TOKEN: "k",
    FORGEJO_ADMIN_PASSWORD: "k",
    KOMODO_ADMIN_PASSWORD: "k",
    RESTIC_PASSWORD: "k",
    GITLAB_TOKEN: "k",
};

const buildGraph = () =>
    defineStack((i) => {
        const host = i.have.host("host", { address: "203.0.113.10", user: "deploy", sshKey: env("HOST_SSH_KEY") });
        const cf = i.have.cloudflare("cf", { apiToken: env("CLOUDFLARE_API_TOKEN") });
        i.want.app("my-app", {
            on: host,
            expose: cf,
            environments: { production: { domain: "app.example.com", branch: "main" } },
        });
    }, "example.com");

// Drive the real registry entirely off in-memory fakes: same wiring the e2e harness uses with real deps.
const realProviders = () =>
    createProviders({
        ssh: fakeSsh(),
        cloudflare: fakeCloudflare(),
        forgejo: fakeForgejoApi(),
        komodo: fakeKomodoApi(),
        dnsPropagation: async () => {},
    });

// The GitLab stack: a hosted git + CI + registry backend (no Forgejo, but Komodo still orchestrates the
// deployments). Same host + Cloudflare, but i.have.gitlab instead: the resolver derives gl-repo/gl-ci and
// the shared Komodo slice + "deployment" nodes.
const buildGitlabGraph = () =>
    defineStack((i) => {
        const host = i.have.host("host", { address: "203.0.113.10", user: "deploy", sshKey: env("HOST_SSH_KEY") });
        const cf = i.have.cloudflare("cf", { apiToken: env("CLOUDFLARE_API_TOKEN") });
        i.have.gitlab("gl", { token: env("GITLAB_TOKEN") });
        i.want.app("my-app", {
            on: host,
            expose: cf,
            environments: { production: { domain: "app.example.com", branch: "main" } },
        });
    }, "example.com");

const gitlabProviders = () =>
    createProviders({
        ssh: fakeSsh(),
        cloudflare: fakeCloudflare(),
        gitlab: fakeGitlabApi(),
        komodo: fakeKomodoApi(),
        dnsPropagation: async () => {},
    });

const base = { env: fullEnv, probe: async () => true, log: () => {} };

test("the full provider suite reconciles an app end-to-end, then is idempotent", async () => {
    const graph = buildGraph();
    const providers = realProviders();

    const first = await apply(graph, { ...base, providers });
    // Owned inventory (host, cf) reads as existing; every derived platform/app node is created.
    const byId = new Map(first.steps.map((step) => [step.id, step.action]));
    expect(byId.get("host")).toBe("noop");
    expect(byId.get("cf")).toBe("noop");
    for (const [id, action] of byId) {
        if (id !== "host" && id !== "cf") {
            expect(action, `expected ${id} to be created`).toBe("create");
        }
    }
    // The whole derived suite is present: git/CI, deploy, repo, ci, deployment, routes.
    expect([...byId.keys()].toSorted()).toEqual(
        [
            "host",
            "cf",
            "host-git",
            "host-git-runner",
            "host-deploy",
            "cf-git-example-com",
            "cf-deploy-example-com",
            "my-app-repo",
            "my-app.production-ci",
            "my-app.production",
            "cf-app-example-com",
            "host-backup",
            "host-tunnel",
        ].toSorted(),
    );
    // Komodo's output is url/internalUrl only: the stale v1 passkey was dropped.
    expect(first.outputs["host-deploy"]).toEqual({ url: "https://deploy.example.com", internalUrl: "http://10.0.0.5:9120" });

    // Same fakes (same world) => everything is found, healthy, and converged => all noop.
    const second = await apply(graph, { ...base, providers });
    expect(second.steps.every((step) => step.action === "noop")).toBe(true);
});

test("the GitLab provider stack reconciles an app end-to-end, then is idempotent", async () => {
    const graph = buildGitlabGraph();
    const providers = gitlabProviders();

    const first = await apply(graph, { ...base, providers });
    const byId = new Map(first.steps.map((step) => [step.id, step.action]));

    // The derived GitLab nodes are created; the gitlab inventory node resolves the owner (noop, like host/cf).
    expect(byId.get("my-app-repo")).toBe("create");
    expect(byId.get("my-app-gl-ci")).toBe("create");
    expect(byId.get("my-app.production")).toBe("create");
    // One project, ONE .gitlab-ci.yml for the app, and the shared Komodo slice (+ its route, backup): no forgejo.
    expect([...byId.keys()].toSorted()).toEqual(
        [
            "host",
            "cf",
            "gl",
            "host-deploy",
            "cf-deploy-example-com",
            "my-app-repo",
            "my-app-gl-ci",
            "my-app.production",
            "cf-app-example-com",
            "host-backup",
            "host-tunnel",
        ].toSorted(),
    );
    // The deployment surfaces the same url/internalUrl shape as on the Forgejo stack.
    expect(first.outputs["my-app.production"]?.["url"]).toBe("https://app.example.com");
    expect(first.outputs["my-app.production"]?.["internalUrl"]).toMatch(/^http:\/\/10\.0\.0\.5:\d+$/);

    // Same fakes => project found, .gitlab-ci.yml unchanged, container running => all noop.
    const second = await apply(graph, { ...base, providers });
    expect(second.steps.every((step) => step.action === "noop")).toBe(true);
});
