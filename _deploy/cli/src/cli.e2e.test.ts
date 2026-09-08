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

// Manual, real-infra E2E: gates on `secrets`, not the token, so a missing credential skips only this tier.
const tier = e2eTier("intentic CLI end-to-end (manual, real Cloudflare + DinD)", {
    enabledBy: "INTENTIC_E2E",
    secrets: ["CLOUDFLARE_API_TOKEN"],
});

const exec = promisify(execFile);

// Zone this suite deploys under; builds the expected hostnames and purges DNS on teardown. Read from env.
const ZONE = process.env["CLOUDFLARE_ZONE"] ?? "atlas-protocol.com";
const ADMIN = "intentic"; // platform admin user and repo owner (resolver's adminUsername).
const APP = "app";
const ENV = "production";
const APP_DOMAIN = `${APP}.${ZONE}`;
const GIT_DOMAIN = `git.${ZONE}`;
const KOMODO_DOMAIN = `deploy.${ZONE}`;
// Sandbox's wildcard preview route (`*.<zone>`); `probe` (non-preview) 404s but still proves the wiring.
const WILDCARD_PREVIEW = `*.${ZONE}`;
const PREVIEW_PROBE = `probe.${ZONE}`;

const repoRoot = findRepoRoot(import.meta.url);
const hostContext = fileURLToPath(new URL("../node_modules/@intentic/dind-host", import.meta.url));

// Deterministic port the resolver assigns; the app must listen on it for Komodo and the tunnel to reach it.
const appPort = deploymentPort(deploymentId(APP, ENV));

// Trivial busybox httpd app serving a known body on $PORT; CI builds it, Komodo deploys with that PORT.
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

// Polls a url through the tunnel until it answers from the real origin, not a Cloudflare edge/tunnel error, retrying
// until the deadline.
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
            // When `bodyIncludes` is set, keep polling until it appears; otherwise any live-origin response is enough.
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
        // Stops the host first so cloudflared dies; Cloudflare refuses to delete a tunnel with active connections.
        await host?.stop().catch(() => {});

        // Purges Cloudflare resources this run created (engine has no destroy path); account id comes from the zone.
        const zone = await cloudflareApi.getZone({ apiToken: tier.secrets.CLOUDFLARE_API_TOKEN, zone: ZONE }).catch(() => undefined);
        if (zone !== undefined) {
            const tunnel = await cloudflareApi
                .findTunnel({ accountId: zone.accountId, apiToken: tier.secrets.CLOUDFLARE_API_TOKEN, name: "intentic-host" })
                .catch(() => undefined);
            if (tunnel !== undefined) {
                // Force-closes lingering connections (cloudflared just died) so the tunnel delete sticks.
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

    // Runs a real `pnpm intentic <args>` from the repo root; surfaces stdout+stderr on failure for debugging.
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

        // 2. Authors the intent (host, Cloudflare, the app's environment) and the secrets apply resolves.
        await writeFile(configPath, config(address, port));
        await writeFile(join(tmp, "desired-state", ".env"), envFile(privateKey));

        // 3. Resolve+apply: brings up Forgejo/Komodo/tunnel/CI-CD and the sandbox (public ghcr.io image).
        await intentic("deploy", "resolve", "--config", configPath, "--out", artifactPath);
        await intentic("deploy", "apply", "--yes", "--artifact", artifactPath, "--maxIterations", "8");

        // Admin password intentic generated, in desired-state/.secrets.json.
        const forgejoPassword = (await readGeneratedSecrets(join(tmp, "desired-state")))["FORGEJO_ADMIN_PASSWORD"] ?? "";

        // The platform containers actually came up on the host.
        const running = await sshRun("docker ps --format '{{.Names}}'");
        expect(running).toContain("intentic-forgejo");
        expect(running).toContain("intentic-forgejo-runner");
        // Komodo's compose stack names its core container komodo-core-1 (matched here as a substring).
        expect(running).toContain("komodo-core");
        expect(running.split("\n").some((name) => name.startsWith("intentic-tunnel-"))).toBe(true);
        // The workspace sandbox came up too (apply gated on its daemon /health before converging).
        expect(running).toContain("intentic-sandbox-workspace");

        // Forgejo + Komodo are reachable from the public internet through the tunnel.
        const git = await pollUrl(`https://${GIT_DOMAIN}`, 120_000);
        expect([200, 301, 302, 303, 401, 403, 404]).toContain(git.status);
        const komodo = await pollUrl(`https://${KOMODO_DOMAIN}`, 120_000);
        expect([200, 301, 302, 303, 401, 403, 404]).toContain(komodo.status);

        // Wildcard preview resolves end-to-end: DNS -> tunnel -> sandbox proxy; a non-preview 404 still proves it.
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

        // CI/CD was already wired by the apply above; pushing the real Dockerfile replaces CI's seeded placeholder.

        // CI/Komodo deploy asynchronously; poll until the real body appears (a placeholder may serve briefly first).
        const app = await pollUrl(`https://${APP_DOMAIN}`, 300_000, APP_BODY);
        expect(app.status).toBe(200);
        expect(app.body).toContain(APP_BODY);

        // By now Komodo has run the app container on the host.
        const appRunning = await sshRun("docker ps --format '{{.Names}}'");
        expect(appRunning).toMatch(/komodo|app/i);
    }, 1_500_000);
});
