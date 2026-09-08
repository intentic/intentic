import { setTimeout as sleep } from "node:timers/promises";
import { execFileSync, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { GenericContainer, PullPolicy, type StartedTestContainer, Wait } from "testcontainers";

// Shared harness for the gated *.e2e.test.ts suites: boots the real sandbox image in loopback mode and plays the
// outside-executor role for overlay builds. Test-only, excluded from the package build.

const root = repoRoot(import.meta.url);

// From-source image tag, stable so docker's layer cache carries across runs; not removed on teardown.
const SOURCE_IMAGE_TAG = "intentic-sandbox-e2e:local";

// Builds via the docker CLI, not testcontainers' fromDockerfile: the Dockerfile needs BuildKit (COPY --chmod) and CLI
// shares CI's layer cache. Composes the STANDARD profile; prepare-image-trees.sh must have run first.
const buildSourceImage = async (): Promise<void> => {
    const dockerfile = join(root, ".image-out/Dockerfile.standard");
    writeFileSync(dockerfile, execFileSync("node", ["_tools/scripts/image/compose-image-dockerfile.mjs", "standard"], { cwd: root }));
    await new Promise<void>((resolve, reject) => {
        const build = spawn("docker", ["build", "--build-context", "trees=.image-out", "-f", dockerfile, "-t", SOURCE_IMAGE_TAG, "."], { cwd: root });
        let output = "";
        build.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
        build.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
        build.on("error", reject);
        build.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`sandbox image build exited ${code}:\n${output.slice(-4000)}`))));
    });
};

// Whether a reference names a registry (so a moving tag gets re-resolved rather than assumed): the first path segment
// counts only if it carries a dot, a colon, or is `localhost`, docker's own rule.
const registryQualified = (image: string): boolean => {
    const [first = "", ...rest] = image.split("/");
    return rest.length > 0 && (first.includes(".") || first.includes(":") || first === "localhost");
};

// Builds this repo's image unless SANDBOX_E2E_IMAGE points at a prebuilt one, then starts it in loopback:
// GOOGLE_CLIENT_ID/PLATFORM_URL stay unset, so auth and announce are off.
export const startSandboxContainer = async (environment: Record<string, string>): Promise<StartedTestContainer> => {
    const prebuilt = process.env["SANDBOX_E2E_IMAGE"];
    let image = prebuilt;
    if (image === undefined || image === "") {
        await buildSourceImage();
        image = SOURCE_IMAGE_TAG;
    }
    // Pulls a registry-qualified tag every run; the default policy would reuse whatever :latest was pulled last.
    const pullPolicy = registryQualified(image) ? PullPolicy.alwaysPull() : PullPolicy.defaultPolicy();
    // Unprivileged, like production; the baked Docker Engine stays dormant. SANDBOX_ALLOW_UNAUTHENTICATED lets these
    // suites drive the daemon with only a CONNECT_TOKEN; omitting it fails as an opaque 180s /health timeout.
    return new GenericContainer(image)
        .withPullPolicy(pullPolicy)
        .withEnvironment({ SANDBOX_ALLOW_UNAUTHENTICATED: "1", ...environment })
        .withExposedPorts(8787, 22)
        .withWaitStrategy(Wait.forHttp("/health", 8787).forStatusCode(200))
        .withStartupTimeout(180_000)
        .start();
};

export const daemonUrl = (container: StartedTestContainer): string => `http://${container.getHost()}:${container.getMappedPort(8787)}`;

// Polls until `read` returns a defined value; daemon-side effects run detached from their HTTP responses.
export const until = async <T>(read: () => Promise<T | undefined>, what: string, timeoutMs = 30_000): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await read();
        if (value !== undefined) {
            return value;
        }
        if (Date.now() >= deadline) {
            throw new Error(`timed out waiting for ${what}`);
        }
        await sleep(500);
    }
};

// `docker build` from stdin, the same command recreate.sh runs. BuildKit is pinned on since the overlay fragments use
// `RUN --mount=type=cache`, which the legacy builder fails on rather than ignores.
export const dockerBuild = (dockerfile: string, tag: string): Promise<void> =>
    new Promise((resolve, reject) => {
        const build = spawn("docker", ["build", "-t", tag, "-"], { env: { ...process.env, DOCKER_BUILDKIT: "1" } });
        let output = "";
        build.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
        build.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
        build.on("error", reject);
        build.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`docker build exited ${code}:\n${output.slice(-4000)}`))));
        build.stdin.end(dockerfile);
    });

// `docker run --rm` with bind mounts, combined output; exercises the whisper overlay without the daemon.
export const dockerRun = (tag: string, mounts: { host: string; container: string }[], command: string[]): Promise<string> =>
    new Promise((resolve, reject) => {
        const args = ["run", "--rm", ...mounts.flatMap((mount) => ["-v", `${mount.host}:${mount.container}:ro`]), tag, ...command];
        const run = spawn("docker", args);
        let output = "";
        run.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
        run.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
        run.on("error", reject);
        run.on("close", (code) => (code === 0 ? resolve(output) : reject(new Error(`docker run exited ${code}:\n${output.slice(-4000)}`))));
    });

export const dockerRmi = (tag: string): Promise<void> =>
    new Promise((resolve) => {
        spawn("docker", ["rmi", "-f", tag]).on("close", () => resolve());
    });
