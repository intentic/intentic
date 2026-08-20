import { setTimeout as sleep } from "node:timers/promises";
import { execFileSync, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";

// Shared harness for the gated *.e2e.test.ts suites (sandbox + discord): boot the REAL sandbox image in
// loopback mode and play the outside-executor role for overlay builds. Test-only, excluded from the package
// build (tsconfig `exclude`), like the test files that import it.

const root = repoRoot(import.meta.url);

// The from-source image tag, a stable name so docker's layer cache carries across runs (the tag is the
// cache; it is deliberately NOT removed on teardown).
const SOURCE_IMAGE_TAG = "intentic-sandbox-e2e:local";

// Build via the docker CLI, not testcontainers' fromDockerfile: the sandbox Dockerfile needs BuildKit
// (COPY --chmod), which the CLI uses by default, and the CLI shares the layer cache with CI's images job.
// The STANDARD profile, the artifact CI publishes under the plain tags, composed fresh from the checked-in
// packs into .image-out beside the `trees` payload, whose preparation the caller owns exactly as every other
// from-source build does (prepare-image-trees.sh must have run).
const buildSourceImage = async (): Promise<void> => {
    const dockerfile = join(root, ".image-out/Dockerfile.standard");
    writeFileSync(dockerfile, execFileSync("node", ["_tools/scripts/compose-image-dockerfile.mjs", "standard"], { cwd: root }));
    await new Promise<void>((resolve, reject) => {
        const build = spawn("docker", ["build", "--build-context", "trees=.image-out", "-f", dockerfile, "-t", SOURCE_IMAGE_TAG, "."], { cwd: root });
        let output = "";
        build.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
        build.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
        build.on("error", reject);
        build.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`sandbox image build exited ${code}:\n${output.slice(-4000)}`))));
    });
};

// Build the image from this repo's Dockerfile (the artifact CI publishes) unless SANDBOX_E2E_IMAGE points at a
// prebuilt one, then start it in loopback: GOOGLE_CLIENT_ID / PLATFORM_URL stay unset, so auth + announce are
// off and the only requirement is a Docker daemon.
export const startSandboxContainer = async (environment: Record<string, string>): Promise<StartedTestContainer> => {
    const prebuilt = process.env["SANDBOX_E2E_IMAGE"];
    let image = prebuilt;
    if (image === undefined || image === "") {
        await buildSourceImage();
        image = SOURCE_IMAGE_TAG;
    }
    // Unprivileged like every production runner's default: the image bakes a Docker Engine but it stays
    // dormant (dockerd starts only when a docker capability is enabled AND the container runs privileged,
    // the overlay-rebuild grant the suites don't exercise).
    //
    // SANDBOX_ALLOW_UNAUTHENTICATED is what lets the suites pass a CONNECT_TOKEN (the only source of a sync ssh
    // hostname) to a daemon they then drive with no credential: main.ts's auth floor kills exactly that pair on
    // sight, and this is the acknowledgement it accepts instead. Set HERE, once, rather than in each suite's
    // environment map, a suite that forgot it would fail as an opaque 180s /health timeout.
    return new GenericContainer(image)
        .withEnvironment({ SANDBOX_ALLOW_UNAUTHENTICATED: "1", ...environment })
        .withExposedPorts(8787, 22)
        .withWaitStrategy(Wait.forHttp("/health", 8787).forStatusCode(200))
        .withStartupTimeout(180_000)
        .start();
};

export const daemonUrl = (container: StartedTestContainer): string => `http://${container.getHost()}:${container.getMappedPort(8787)}`;

// Poll until `read` returns a defined value, daemon-side effects (automation fires, approval holds, gateway
// dispatches) run detached from their HTTP responses.
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

// `docker build` the composed overlay from stdin, the exact command recreate.sh runs (`docker build - <overlay`).
export const dockerBuild = (dockerfile: string, tag: string): Promise<void> =>
    new Promise((resolve, reject) => {
        const build = spawn("docker", ["build", "-t", tag, "-"]);
        let output = "";
        build.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
        build.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
        build.on("error", reject);
        build.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`docker build exited ${code}:\n${output.slice(-4000)}`))));
        build.stdin.end(dockerfile);
    });

// `docker run --rm <tag> <command…>` with bind mounts, returning combined output, how the whisper overlay is
// exercised without the daemon (the binary lives in the rebuilt image, not the running container).
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
