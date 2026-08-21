import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { repoRoot as findRepoRoot } from "@intentic/constants/node";
import { cloudflareApi, forgejoApi, sshExecutor } from "@intentic/providers";
import { deploymentId, deploymentPort } from "@intentic/state-resolver";
import { e2eTier } from "@intentic/testing/e2e";
import { utils } from "ssh2";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readGeneratedSecrets } from "./secrets/generated-secrets.js";

// The realistic Tier-1 run: boot a Docker-in-Docker "host", then drive the REAL CLI (pnpm intentic
// init/resolve/apply) exactly as an operator would: scaffold, author a deploy.config.ts pointed at the
// DinD host's mapped SSH port, fill desired-state/.env, resolve, apply. Phase 1 stands up the platform
// (Forgejo + runner + Komodo) and exposes git.<zone>/deploy.<zone> through a real Cloudflare tunnel. Then we
// push a tiny Dockerfile to the app repo and, in phase 2, author an environment so apply WIRES CI/CD (a
// Forgejo Actions workflow + a Komodo registry deployment): intentic does not build or deploy. The workflow
// then builds + pushes the image and Komodo rolls it out live at app.<zone>. Gated behind INTENTIC_E2E because
// it needs a privileged Docker daemon + live Cloudflare credentials (with DNS-edit + tunnel-edit scopes) on a
// zone you own, so `pnpm test` never reaches it, and in CI only the nightly does, and only when it holds a
// token to reach Cloudflare with.
//
// The host SSH key is generated per-run and written into the .env the CLI loads; the Forgejo/Komodo admin
// passwords are intentic-generated (read back from desired-state/.secrets.json to sign in).
//
// The TOKEN gates the tier alongside INTENTIC_E2E, the same way every other gated suite names its own
// credentials. That is the nightly job's whole contract (.github/workflows/nightly.yml `e2e`): it sets INTENTIC_E2E=1
// for every tier and each suite decides for itself whether its secrets are present. Asserting the token inside
// instead turned "this project has no Cloudflare credentials" into a red pipeline every night.
const tier = e2eTier("intentic CLI end-to-end (manual, real Cloudflare + DinD)", {
    enabledBy: "INTENTIC_E2E",
    secrets: ["CLOUDFLARE_API_TOKEN"],
});

const exec = promisify(execFile);

// The Cloudflare zone this suite deploys under. The config no longer authors it: the CLI discovers it from
// the app domains + token, but the harness still needs it to build the expected public hostnames and to
// purge DNS on teardown. Read from env so the suite can target any zone you own (the account is discovered
// from the token); use a token scoped to this zone so the platform-only phase (no app domains) can resolve it.
const ZONE = process.env["CLOUDFLARE_ZONE"] ?? "atlas-protocol.com";
const ADMIN = "intentic"; // the platform admin user + repo owner (adminUsername in the resolver)
const APP = "app";
const ENV = "production";
const APP_DOMAIN = `${APP}.${ZONE}`;
const GIT_DOMAIN = `git.${ZONE}`;
const KOMODO_DOMAIN = `deploy.${ZONE}`;
// The workspace sandbox exposes a single-label wildcard preview route to its own dev server. The cf-route owns
// a proxied `*.<zone>` CNAME (purged on teardown); `probe` is a concrete host under it the test curls (a
// non-`preview-` host, so the proxy answers 404: enough to prove DNS + tunnel + proxy are wired).
const WILDCARD_PREVIEW = `*.${ZONE}`;
const PREVIEW_PROBE = `probe.${ZONE}`;

const repoRoot = findRepoRoot(import.meta.url);
const hostContext = fileURLToPath(new URL("../node_modules/@intentic/dind-host", import.meta.url));

// The deterministic host port the resolver assigns this environment's deployment; the seeded app must listen
// on it (Komodo runs the container on the host network, so it binds this port directly) and the tunnel routes
// app.<zone> to it.
const appPort = deploymentPort(deploymentId(APP, ENV));

// A trivial buildable app: busybox httpd serving a known body on $PORT. The Forgejo Action builds this into
// an image and pushes it to the registry; Komodo deploys it with PORT set to the resolver's deterministic port.
const APP_BODY = "intentic-e2e-live";
const DOCKERFILE = `FROM busybox:1.38.0@sha256:dc2d74b28e4cf8984fa52af1f39bc7c3d9c73760b41a74d629f5d11b1ab28616
RUN mkdir -p /www && printf '%s' '${APP_BODY}' > /www/index.html
ENV PORT=8080
EXPOSE 8080
CMD ["sh","-c","httpd -f -v -p \${PORT} -h /www"]
`;

const config = (address: string, port: number): string => `import { env } from "@intentic/graph";
import { defineIntent } from "@intentic/sdk";

export const intent = defineIntent((i) => {
    const host = i.have.host("host", {
        address: ${JSON.stringify(address)},
        user: "root",
        sshKey: env("HOST_SSH_KEY"),
        port: ${port},
    });

    const cf = i.have.cloudflare("cf", {
        apiToken: env("CLOUDFLARE_API_TOKEN"),
    });

    i.want.app(${JSON.stringify(APP)}, {
        on: host,
        expose: cf,
        environments: {
            ${ENV}: { domain: ${JSON.stringify(APP_DOMAIN)}, branch: "main", env: { PORT: ${JSON.stringify(String(appPort))} } },
        },
    });

    // The AI-agent workspace sandbox: stood up on the host, serving its dev-server previews behind the *.<zone> wildcard.
    i.want.workspace("workspace", { on: host, expose: cf });
});
`;

const envFile = (privateKey: string): string =>
    `HOST_SSH_KEY="${privateKey}"
CLOUDFLARE_API_TOKEN=${tier.secrets.CLOUDFLARE_API_TOKEN}
`;

// Poll a public URL through the tunnel until it answers from the origin (not a Cloudflare edge error),
// then return the final status + body. Edge/tunnel-not-ready responses (5xx + the cloudflared error page)
// are retried until the deadline since DNS + connector propagation takes seconds.
const pollUrl = async (url: string, timeoutMs: number, bodyIncludes?: string): Promise<{ status: number; body: string }> => {
    const deadline = Date.now() + timeoutMs;
    let last: { status: number; body: string } | undefined;
    for (;;) {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 10_000);
            const response = await fetch(url, { redirect: "manual", signal: controller.signal });
            clearTimeout(timer);
            const body = (await response.text()).slice(0, 4000);
            last = { status: response.status, body };
            const edgeDown = [502, 521, 522, 523, 525, 530].includes(response.status) || /Error 10\d\d|Argo Tunnel|cloudflare/i.test(body);
            // When a body marker is required (the app must serve its real content, not CI's seeded
            // placeholder), keep polling until it appears; otherwise any live-origin response is enough.
            if (!edgeDown && (bodyIncludes === undefined || body.includes(bodyIncludes))) {
                return last;
            }
        } catch {
            // DNS not propagated / connection reset: keep polling.
        }
        if (Date.now() >= deadline) {
            throw new Error(`${url} never returned a live-origin response; last=${JSON.stringify(last)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
};

describe.skipIf(!tier.runs)(tier.title, () => {
    let host: StartedTestContainer;
    let tmp: string;
    let privateKey: string;

    beforeAll(async () => {
        const keys = utils.generateKeyPairSync("ed25519");
        privateKey = keys.private;

        const image = await GenericContainer.fromDockerfile(hostContext).build();
        host = await image
            .withPrivilegedMode()
            .withEnvironment({ DOCKER_TLS_CERTDIR: "" })
            .withExposedPorts(22)
            .withCopyContentToContainer([{ content: keys.public, target: "/root/.ssh/authorized_keys", mode: 0o600 }])
            .withWaitStrategy(Wait.forListeningPorts())
            .withStartupTimeout(180_000)
            .start();

        tmp = await mkdtemp(join(tmpdir(), "intentic-cli-e2e-"));
    }, 300_000);

    afterAll(async () => {
        // Stop the host FIRST so cloudflared dies: Cloudflare refuses to delete a tunnel with active
        // connections, so the connector must be gone before we purge the tunnel below.
        await host?.stop().catch(() => {});

        // Purge the live Cloudflare resources this run created: the engine has no destroy path. The account id
        // comes back from resolving the zone (the same discovery the CLI does), so it is not configured here.
        const zone = await cloudflareApi.getZone({ apiToken: tier.secrets.CLOUDFLARE_API_TOKEN, zone: ZONE }).catch(() => undefined);
        if (zone !== undefined) {
            const tunnel = await cloudflareApi
                .findTunnel({ accountId: zone.accountId, apiToken: tier.secrets.CLOUDFLARE_API_TOKEN, name: "intentic-host" })
                .catch(() => undefined);
            if (tunnel !== undefined) {
                // Force-close any lingering connections (cloudflared just died with the host) so the delete sticks.
                await fetch(`https://api.cloudflare.com/client/v4/accounts/${zone.accountId}/cfd_tunnel/${tunnel.id}/connections`, {
                    method: "DELETE",
                    headers: { Authorization: `Bearer ${tier.secrets.CLOUDFLARE_API_TOKEN}` },
                }).catch(() => {});
                await cloudflareApi
                    .deleteTunnel({ accountId: zone.accountId, apiToken: tier.secrets.CLOUDFLARE_API_TOKEN, tunnelId: tunnel.id })
                    .catch((error) => console.warn(`tunnel cleanup: ${String(error)}`));
            }
            for (const name of [GIT_DOMAIN, KOMODO_DOMAIN, APP_DOMAIN, WILDCARD_PREVIEW]) {
                const record = await cloudflareApi
                    .findDnsRecord({ apiToken: tier.secrets.CLOUDFLARE_API_TOKEN, zoneId: zone.id, name })
                    .catch(() => undefined);
                if (record !== undefined) {
                    await cloudflareApi
                        .deleteDnsRecord({ apiToken: tier.secrets.CLOUDFLARE_API_TOKEN, zoneId: zone.id, recordId: record.id })
                        .catch((error) => console.warn(`dns cleanup ${name}: ${String(error)}`));
                }
            }
        }
        if (tmp !== undefined) {
            await rm(tmp, { recursive: true, force: true }).catch(() => {});
        }
    }, 180_000);

    // Run a real `pnpm intentic <args>` from the repo root; surface stdout+stderr on failure so a broken
    // apply is debuggable from the test output.
    const intentic = async (...args: string[]): Promise<string> => {
        try {
            const { stdout } = await exec("pnpm", ["intentic", ...args], { cwd: repoRoot, env: process.env, maxBuffer: 64 * 1024 * 1024 });
            return stdout;
        } catch (error) {
            const e = error as { code?: number; stdout?: string; stderr?: string };
            throw new Error(`pnpm intentic ${args.join(" ")} failed (code ${e.code}):\nSTDOUT:\n${e.stdout ?? ""}\nSTDERR:\n${e.stderr ?? ""}`, {
                cause: error,
            });
        }
    };

    const sshRun = async (command: string): Promise<string> => {
        const session = await sshExecutor.connect({ address: host.getHost(), port: host.getMappedPort(22), user: "root", privateKey });
        try {
            return (await session.exec(command)).stdout;
        } finally {
            await session.dispose();
        }
    };

    it("scaffolds, exposes Forgejo + Komodo, then builds and deploys a real app: all through the CLI", async () => {
        const address = host.getHost();
        const port = host.getMappedPort(22);

        // 1. Scaffold the two local repos with @intentic/* linked to this monorepo's source.
        await intentic("deploy", "init", "--dir", tmp, "--link");

        const configPath = join(tmp, "intent", "deploy.config.ts");
        const artifactPath = join(tmp, "desired-state", "desired-state.json");

        // 2. Author the intent (host + Cloudflare + the app's production environment) + the secrets apply resolves.
        await writeFile(configPath, config(address, port));
        await writeFile(join(tmp, "desired-state", ".env"), envFile(privateKey));

        // 3. Resolve + apply: brings up Forgejo + its Actions runner + Komodo + the workspace sandbox + the
        // tunnel/routes, and wires the app's CI/CD. The workspace provider PULLS the published sandbox image
        // (ghcr.io/intentic/sandbox) from GHCR: it must be published under that name + public.
        await intentic("deploy", "resolve", "--config", configPath, "--out", artifactPath);
        await intentic("deploy", "apply", "--yes", "--artifact", artifactPath, "--maxIterations", "8");

        // The admin password intentic generated (in desired-state/.secrets.json): what bootstrapped Forgejo.
        const forgejoPassword = (await readGeneratedSecrets(join(tmp, "desired-state")))["FORGEJO_ADMIN_PASSWORD"] ?? "";

        // The platform containers actually came up on the host.
        const running = await sshRun("docker ps --format '{{.Names}}'");
        expect(running).toContain("intentic-forgejo");
        expect(running).toContain("intentic-forgejo-runner");
        // Komodo runs as a docker compose stack, so its core container is named "komodo-core-1".
        expect(running).toContain("komodo-core");
        expect(running.split("\n").some((name) => name.startsWith("intentic-tunnel-"))).toBe(true);
        // The workspace sandbox came up too (apply gated on its daemon /health before converging).
        expect(running).toContain("intentic-sandbox-workspace");

        // Forgejo + Komodo are reachable from the public internet through the tunnel.
        const git = await pollUrl(`https://${GIT_DOMAIN}`, 120_000);
        expect([200, 301, 302, 303, 401, 403, 404]).toContain(git.status);
        const komodo = await pollUrl(`https://${KOMODO_DOMAIN}`, 120_000);
        expect([200, 301, 302, 303, 401, 403, 404]).toContain(komodo.status);

        // The wildcard preview route resolves end-to-end: DNS (`*.<zone>`) -> the host tunnel ingress -> the
        // sandbox's preview proxy (port 5173, bound to the host's internal ip). A non-`preview-` host gets a
        // 404 from the proxy: that still proves the route is wired through.
        const preview = await pollUrl(`https://${PREVIEW_PROBE}`, 240_000);
        expect([200, 301, 302, 303, 401, 403, 404]).toContain(preview.status);

        // 4. Push a buildable app to the repo apply just created (the realistic "developer pushes code").
        await forgejoApi.commitFile({
            baseUrl: `https://${GIT_DOMAIN}`,
            user: ADMIN,
            password: forgejoPassword,
            owner: ADMIN,
            name: APP,
            branch: "main",
            path: "Dockerfile",
            content: DOCKERFILE,
            message: "seed e2e app",
        });

        // 5. The app's CI/CD was already wired by the apply above (Forgejo Actions workflow + Komodo deployment);
        // CI seeded a placeholder Dockerfile, so pushing the real one above triggers the Action: build -> push to
        // the registry -> notify Komodo, which rolls it out, replacing the placeholder.

        // CI builds + pushes and Komodo deploys asynchronously, and the placeholder may serve briefly first, so
        // poll until the app serves its real body (allow generous time for the first rollout).
        const app = await pollUrl(`https://${APP_DOMAIN}`, 300_000, APP_BODY);
        expect(app.status).toBe(200);
        expect(app.body).toContain(APP_BODY);

        // By now Komodo has run the app container on the host.
        const appRunning = await sshRun("docker ps --format '{{.Names}}'");
        expect(appRunning).toMatch(/komodo|app/i);
    }, 1_500_000);
});
