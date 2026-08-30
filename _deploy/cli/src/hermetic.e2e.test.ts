import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { repoRoot as findRepoRoot } from "@intentic/constants/node";
import { forgejoApi, type SshResult, sshExecutor } from "@intentic/providers";
import { adminUsername, deploymentId, forgejoId, komodoId, runnerId, tunnelId } from "@intentic/state-resolver";
import { e2eTier } from "@intentic/testing/e2e";
import { utils } from "ssh2";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APPLY_WORKFLOW_PATH, forgejoSecretName, GIT_TOKEN_SECRET, GIT_USER_SECRET, INTENT_WORKFLOW_PATH } from "./pipelines/adopt-pipelines.js";
import { readGeneratedSecrets } from "./secrets/generated-secrets.js";

// The hermetic Tier-1 run: the same DinD host + real CLI as cli.e2e.test.ts, but with ZERO external
// dependencies: no Cloudflare token, no zone, no DNS, no tunnel. Two existing seams make that possible:
// an authored `zone` resolves the full artifact offline (no token/network), and `apply --target` over the
// derived platform trio (forgejo + runner + komodo) reconciles a slice whose inputs reference nothing but
// the host. This covers exactly the deployment path that breaks in the field: the derived control plane
// coming up on a real Docker host, gated by the engine-level SSH readiness probe: plus `adopt` against the
// real Forgejo, idempotent re-runs, and a reproduced readiness failure asserting the diagnostic sweep.
// Gated behind INTENTIC_E2E_HERMETIC (needs a privileged local Docker daemon); runs as a non-blocking MR
// sidecar in CI, while the Cloudflare-backed cli.e2e stays nightly.
// Its own switch, not the nightly's: naming no secrets is exactly what lets this tier run on every merge
// request, so it must not turn on with the gated ones.
const tier = e2eTier("intentic CLI hermetic end-to-end (DinD, no external services)", { enabledBy: "INTENTIC_E2E_HERMETIC" });

const exec = promisify(execFile);

const repoRoot = findRepoRoot(import.meta.url);
const hostContext = fileURLToPath(new URL("../node_modules/@intentic/dind-host", import.meta.url));

// An RFC 2606 reserved TLD: resolvable by no one, so a hermetic run that accidentally reaches for the
// public domain fails loudly instead of leaking traffic.
const ZONE = "e2e.test";
const HOST = "host";
const FORGEJO = forgejoId(HOST);
const RUNNER = runnerId(HOST);
const KOMODO = komodoId(HOST);
const TUNNEL = tunnelId(HOST);
const TARGET = `${FORGEJO},${RUNNER},${KOMODO}`;
const FORGEJO_PORT = 3000;
const KOMODO_PORT = 9120;
const INTERNAL_IP_COMMAND = "ip -4 -o route get 1.1.1.1 | awk '{print $7; exit}'";

const config = (address: string, port: number): string => `import { env } from "@intentic/graph";
import { defineIntent } from "@intentic/sdk";

export const intent = defineIntent((i) => {
    const host = i.have.host(${JSON.stringify(HOST)}, {
        address: ${JSON.stringify(address)},
        user: "root",
        sshKey: env("HOST_SSH_KEY"),
        port: ${port},
    });

    // The authored zone makes resolve fully offline: the dummy token is never sent anywhere.
    const cf = i.have.cloudflare("cf", {
        apiToken: env("CLOUDFLARE_API_TOKEN"),
        zone: ${JSON.stringify(ZONE)},
    });

    i.want.app("app", {
        on: host,
        expose: cf,
        environments: {
            production: { domain: ${JSON.stringify(`app.${ZONE}`)}, branch: "main" },
        },
    });
});
`;

const envFile = (privateKey: string): string =>
    `HOST_SSH_KEY="${privateKey}"
CLOUDFLARE_API_TOKEN=hermetic-dummy
`;

describe.skipIf(!tier.runs)(tier.title, () => {
    let host: StartedTestContainer;
    let tmp: string;
    let privateKey: string;
    let configPath: string;
    let artifactPath: string;
    let targetDir: string;

    beforeAll(async () => {
        const keys = utils.generateKeyPairSync("ed25519");
        privateKey = keys.private;

        const configure = (container: GenericContainer): GenericContainer =>
            container
                .withPrivilegedMode()
                .withEnvironment({ DOCKER_TLS_CERTDIR: "" })
                .withExposedPorts(22, FORGEJO_PORT)
                .withCopyContentToContainer([{ content: keys.public, target: "/root/.ssh/authorized_keys", mode: 0o600 }])
                // Port 3000 stays silent until apply boots Forgejo, so waiting on listening ports would
                // hang: wait for sshd instead (the entrypoint starts it only after dockerd accepts commands).
                .withWaitStrategy(Wait.forSuccessfulCommand("nc -z 127.0.0.1 22"))
                .withStartupTimeout(180_000);

        // CI provides the published dind-host image; anything else (missing var, private registry, local
        // run) falls back to building @intentic/dind-host locally.
        const image = process.env["INTENTIC_HOST_IMAGE"];
        if (image !== undefined && image !== "") {
            try {
                host = await configure(new GenericContainer(image)).start();
            } catch {
                host = await configure(await GenericContainer.fromDockerfile(hostContext).build()).start();
            }
        } else {
            host = await configure(await GenericContainer.fromDockerfile(hostContext).build()).start();
        }

        tmp = await mkdtemp(join(tmpdir(), "intentic-hermetic-e2e-"));
        configPath = join(tmp, "intent", "deploy.config.ts");
        targetDir = join(tmp, "desired-state");
        artifactPath = join(targetDir, "desired-state.json");
    }, 300_000);

    afterAll(async () => {
        // Nothing external exists: stop the host and remove the scaffold, done.
        await host?.stop().catch(() => {});
        if (tmp !== undefined) {
            await rm(tmp, { recursive: true, force: true }).catch(() => {});
        }
    }, 60_000);

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

    const sshRun = async (command: string): Promise<SshResult> => {
        const session = await sshExecutor.connect({ address: host.getHost(), port: host.getMappedPort(22), user: "root", privateKey });
        try {
            return await session.exec(command);
        } finally {
            await session.dispose();
        }
    };

    const readStatus = async (): Promise<{ converged: boolean; iterations: number; steps: { id: string; action: string }[] }> =>
        JSON.parse(await readFile(join(targetDir, "status.json"), "utf8")) as {
            converged: boolean;
            iterations: number;
            steps: { id: string; action: string }[];
        };

    const forgejoBaseUrl = (): string => `http://${host.getHost()}:${host.getMappedPort(FORGEJO_PORT)}`;

    const forgejoPassword = async (): Promise<string> => (await readGeneratedSecrets(targetDir))["FORGEJO_ADMIN_PASSWORD"] ?? "";

    it("resolve derives the forgejo/komodo platform offline from the authored zone", async () => {
        await intentic("deploy", "init", "--dir", tmp, "--link");
        await writeFile(configPath, config(host.getHost(), host.getMappedPort(22)));
        await writeFile(join(targetDir, ".env"), envFile(privateKey));

        await intentic("deploy", "resolve", "--config", configPath, "--out", artifactPath);

        const artifact = JSON.parse(await readFile(artifactPath, "utf8")) as {
            resources: Record<string, { dependsOn: string[]; readyWhen?: unknown }>;
        };
        for (const id of [HOST, FORGEJO, RUNNER, KOMODO, TUNNEL, deploymentId("app", "production")]) {
            expect(Object.keys(artifact.resources)).toContain(id);
        }
        expect(artifact.resources[FORGEJO]?.dependsOn).toEqual([HOST]);
        expect(artifact.resources[FORGEJO]?.readyWhen).toEqual({
            check: "httpOk",
            url: { $ref: `${FORGEJO}.internalUrl` },
            timeout: "120s",
        });
    }, 120_000);

    it("targeted apply stands up the derived platform with no cloudflare access", async () => {
        await intentic("deploy", "apply", "--yes", "--artifact", artifactPath, "--maxIterations", "8", "--target", TARGET);

        const status = await readStatus();
        expect(status.converged).toBe(true);
        const actions = new Map(status.steps.map((step) => [step.id, step.action]));
        expect(actions.get(FORGEJO)).toBe("create");
        expect(actions.get(RUNNER)).toBe("create");
        expect(actions.get(KOMODO)).toBe("create");

        const running = (await sshRun("docker ps --format '{{.Names}}'")).stdout;
        expect(running).toContain("intentic-forgejo");
        expect(running).toContain("intentic-forgejo-runner");
        expect(running).toContain("komodo-core");

        // Re-verify the engine's readiness gate independently: the derived internalUrl must be fetchable
        // FROM THE HOST at the discovered internalIp: the exact check that timed out in the field.
        const internalIp = (await sshRun(INTERNAL_IP_COMMAND)).stdout.trim();
        expect(internalIp).not.toBe("");
        expect((await sshRun(`wget -q -T 10 -O /dev/null http://${internalIp}:${FORGEJO_PORT}`)).code).toBe(0);
        expect((await sshRun(`wget -q -T 10 -O /dev/null http://${internalIp}:${KOMODO_PORT}`)).code).toBe(0);

        const generated = await readGeneratedSecrets(targetDir);
        // Non-empty and whitespace-free each, and DIFFERENT from one another. The last of those is the one worth
        // having: one secret generated once and written under two names satisfies "both are truthy" perfectly.
        expect(generated["FORGEJO_ADMIN_PASSWORD"]).toMatch(/^\S+$/);
        expect(generated["KOMODO_ADMIN_PASSWORD"]).toMatch(/^\S+$/);
        expect(generated["FORGEJO_ADMIN_PASSWORD"]).not.toBe(generated["KOMODO_ADMIN_PASSWORD"]);
    }, 900_000);

    it("a second targeted apply is all-noop", async () => {
        await intentic("deploy", "apply", "--yes", "--artifact", artifactPath, "--target", TARGET);

        const status = await readStatus();
        expect(status.converged).toBe(true);
        expect(status.iterations).toBe(1);
        // The slice: host + the derived trio, every one read back as already-converged.
        expect(status.steps).toHaveLength(4);
        expect(status.steps.every((step) => step.action === "noop")).toBe(true);
    }, 120_000);

    it("adopt pushes the intent and desired-state repos into the real Forgejo over --baseUrl", async () => {
        const baseUrl = forgejoBaseUrl();
        const password = await forgejoPassword();

        await intentic("deploy", "adopt", "--artifact", artifactPath, "--baseUrl", baseUrl);

        const creds = { baseUrl, user: adminUsername, password };
        // The repo that came back is the repo that was asked for: `findRepo` answering with SOMETHING says
        // nothing about which of the two it found, and these two calls differ only in that name.
        expect(await forgejoApi.findRepo({ ...creds, owner: adminUsername, name: "intent" })).toMatchObject({ name: "intent" });
        expect(await forgejoApi.findRepo({ ...creds, owner: adminUsername, name: "desired-state" })).toMatchObject({ name: "desired-state" });
        const onMain = { ...creds, owner: adminUsername, branch: "main" };
        // A file that exists reads back as text. `expect.any(String)` fails on the undefined a missing path
        // returns, and unlike a bare presence check it also rejects a client that answered with a buffer or a
        // parsed object, which is what a wire change here would actually look like.
        expect(await forgejoApi.readFile({ ...onMain, name: "intent", path: "deploy.config.ts" })).toEqual(expect.any(String));
        expect(await forgejoApi.readFile({ ...onMain, name: "intent", path: INTENT_WORKFLOW_PATH })).toEqual(expect.any(String));
        expect(await forgejoApi.readFile({ ...onMain, name: "desired-state", path: APPLY_WORKFLOW_PATH })).toEqual(expect.any(String));

        // Actions secrets landed on both repos (list via the raw API: the provider client only writes).
        const listSecrets = async (name: string): Promise<string[]> => {
            const response = await fetch(`${baseUrl}/api/v1/repos/${adminUsername}/${name}/actions/secrets`, {
                headers: { Authorization: `Basic ${Buffer.from(`${adminUsername}:${password}`).toString("base64")}` },
            });
            expect(response.status).toBe(200);
            return ((await response.json()) as { name: string }[]).map((secret) => secret.name.toUpperCase());
        };
        const intentSecrets = await listSecrets("intent");
        expect(intentSecrets).toContain(GIT_USER_SECRET);
        expect(intentSecrets).toContain(GIT_TOKEN_SECRET);
        const applySecrets = await listSecrets("desired-state");
        // Reserved-prefix keys (FORGEJO_*) are stored under their INTENTIC_-prefixed name: assert the
        // same transform the PUT and the workflow reference use.
        for (const key of ["HOST_SSH_KEY", "CLOUDFLARE_API_TOKEN", "FORGEJO_ADMIN_PASSWORD", "KOMODO_ADMIN_PASSWORD"]) {
            expect(applySecrets).toContain(forgejoSecretName(key));
        }

        // The sync record adopt writes so `secrets list/push` can report CI staleness.
        expect(JSON.parse(await readFile(join(targetDir, ".secrets-sync.json"), "utf8"))).toHaveProperty("HOST_SSH_KEY");
    }, 180_000);

    it("adopt is idempotent", async () => {
        const output = await intentic("deploy", "adopt", "--artifact", artifactPath, "--baseUrl", forgejoBaseUrl());
        expect(output).toContain("secret(s)");
    }, 60_000);

    it("a readiness-gate failure self-explains with the SSH diagnostic sweep", async () => {
        // Reproduce the field failure class: the service is healthy in-container (the provider's own
        // localhost healthcheck passes) but unreachable at the discovered internalIp (the engine gate's
        // host-side probe). An iptables DROP on the internalIp:3000 INPUT path creates exactly that split:
        // the provider probes http://localhost:3000 (dst 127.0.0.1, unmatched), the gate probes
        // http://<internalIp>:3000 (matched, dropped). readyWhen sits outside `inputs`, so shrinking the
        // timeout does not perturb the stamp hash; removing the container forces a create so the gate
        // (skipped on noop) actually runs.
        const artifact = JSON.parse(await readFile(artifactPath, "utf8")) as {
            resources: Record<string, { readyWhen?: { timeout?: string } }>;
        };
        const readyWhen = artifact.resources[FORGEJO]?.readyWhen;
        if (readyWhen === undefined) {
            throw new Error(`artifact has no readyWhen on ${FORGEJO}`);
        }
        readyWhen.timeout = "15s";
        await writeFile(artifactPath, JSON.stringify(artifact, undefined, 4));

        const internalIp = (await sshRun(INTERNAL_IP_COMMAND)).stdout.trim();
        const spec = `-p tcp -d ${internalIp} --dport ${FORGEJO_PORT} -j DROP`;
        expect((await sshRun(`iptables -I INPUT 1 ${spec}`)).code).toBe(0);
        expect((await sshRun("docker rm -f intentic-forgejo")).code).toBe(0);

        const error = await intentic("deploy", "apply", "--yes", "--artifact", artifactPath, "--target", TARGET).then(
            () => undefined,
            (thrown: unknown) => thrown as Error,
        );
        const output = error?.message ?? "";
        expect(output).toContain(`readiness check timed out after 15000ms for http://${internalIp}:${FORGEJO_PORT} (resource "${FORGEJO}")`);
        expect(output).toContain("--- readiness diagnostics: root@");
        expect(output).toContain("$ docker logs --tail 50 intentic-forgejo");
        expect(output).toMatch(/LISTEN.*:3000/);
        expect(output).toContain("$ ip -4 -o addr");

        // Recovery: lift the block, restore the timeout, re-apply, the recreated forgejo reads healthy.
        expect((await sshRun(`iptables -D INPUT ${spec}`)).code).toBe(0);
        readyWhen.timeout = "120s";
        await writeFile(artifactPath, JSON.stringify(artifact, undefined, 4));
        await intentic("deploy", "apply", "--yes", "--artifact", artifactPath, "--target", TARGET);
        expect((await readStatus()).converged).toBe(true);
    }, 360_000);
});
