import { HOST_STATE_ROOT } from "@intentic/constants";
import type { Provider, ResolvedInputs } from "@intentic/engine";
import { HASH_KEY } from "@intentic/graph";
import { z } from "zod";
import { hasPendingRef, parseInputs, sshSchema, sshTarget } from "../core/inputs.js";
import { listStampedContainers } from "../core/list-stamped.js";
import type { SshExecutor, SshSession } from "../core/ssh.js";
import { sshExecutor } from "../core/ssh.js";
import { shellQuote } from "@intentic/sandbox-run/quote";

// image is the act_runner image; jobImage is what each `runs-on: docker` job runs in (docker CLI + buildx are
// bind-mounted from the host). Both are tracked: the runner image on the container, the job image in config.yaml.
const runnerSchema = sshSchema.extend({ instanceUrl: z.string(), token: z.string(), image: z.string(), jobImage: z.string() });
type RunnerInputs = z.infer<typeof runnerSchema>;
const parse = (inputs: ResolvedInputs): RunnerInputs => parseInputs(runnerSchema, inputs, "forgejo-runner");

const CONTAINER = "intentic-forgejo-runner";
const CONFIG_DIR = `${HOST_STATE_ROOT}/runner`;

// act_runner config: host networking, the docker socket auto-mounted (docker_host: automount), and the host's
// static docker CLI + buildx plugin bind-mounted in, so jobs build with the host docker. Paths vary by distro.
const runnerConfig = (dockerBin: string, buildxPlugin: string, jobImage: string): string =>
    [
        "runner:",
        `  labels: [ "docker:docker://${jobImage}" ]`,
        "container:",
        "  network: host",
        "  docker_host: automount",
        `  options: -v ${dockerBin}:/usr/local/bin/docker:ro -v ${buildxPlugin}:/usr/local/lib/docker/cli-plugins/docker-buildx:ro`,
        "  valid_volumes:",
        `    - ${dockerBin}`,
        `    - ${buildxPlugin}`,
        "",
    ].join("\n");

const running = async (session: SshSession): Promise<boolean> => {
    const result = await session.exec(`docker ps --filter "name=^${CONTAINER}$" --format '{{.Names}}'`);
    return result.stdout.trim() === CONTAINER;
};

// A registered runner writes /data/.runner recording its bound instance; missing or mismatched means it must
// re-register.
const registeredTo = async (session: SshSession, instanceUrl: string): Promise<boolean> => {
    const result = await session.exec(`docker exec ${CONTAINER} cat /data/.runner 2>/dev/null || true`);
    return result.stdout.includes(instanceUrl);
};

// Runner image is the container's create-time reference; job image lives in config.yaml's label line, read back
// from the host file since it is never a running container to inspect.
const runningImage = async (session: SshSession): Promise<string> => {
    const result = await session.exec(`docker inspect --format '{{.Config.Image}}' ${CONTAINER} 2>/dev/null || true`);
    return result.stdout.trim();
};

const configuredJobImage = async (session: SshSession): Promise<string> => {
    const result = await session.exec(`cat ${CONFIG_DIR}/config.yaml 2>/dev/null || true`);
    const match = result.stdout.match(/docker:\/\/(\S+?)"/);
    return match?.[1] ?? "";
};

// Forgejo Actions runner (act_runner) for a host, registered with the platform's runner token; no outputs, it's
// a worker. `read` returns the resource only when the container is up and registered to the desired instance.
export const createForgejoRunnerProvider = (executor: SshExecutor = sshExecutor): Provider => ({
    read: async (inputs, ctx) => {
        // A pending dependency means this resource cannot be introspected yet; parsing would crash on the symbol.
        if (hasPendingRef(inputs, "instanceUrl", "token")) {
            return undefined;
        }
        const parsed = parse(inputs);
        let session: SshSession;
        try {
            session = await executor.connect(sshTarget(parsed));
        } catch (error) {
            ctx.log(`forgejo-runner "${ctx.id}": host not reachable over SSH, treating as not-yet-created: ${String(error)}`);
            return undefined;
        }
        try {
            if (!(await running(session)) || !(await registeredTo(session, parsed.instanceUrl))) {
                return undefined;
            }
            const stampHash = (
                await session.exec(`docker inspect --format ${shellQuote(`{{index .Config.Labels "${HASH_KEY}"}}`)} ${CONTAINER}`)
            ).stdout.trim();
            return {
                outputs: {},
                detail: { image: await runningImage(session), jobImage: await configuredJobImage(session) },
                ...(stampHash === "" ? {} : { stampHash }),
            };
        } finally {
            await session.dispose();
        }
    },
    // Recreates on a runner-image bump or job-image change (the latter only rewrites config.yaml + restarts the
    // daemon); the registration in /data survives, so re-register is a noop.
    diff: (inputs, observed) => {
        const parsed = parse(inputs);
        if (observed.detail?.["image"] !== parsed.image) {
            return { action: "update", reason: `forgejo-runner image differs (running ${String(observed.detail?.["image"])}, want ${parsed.image})` };
        }
        if (observed.detail?.["jobImage"] !== parsed.jobImage) {
            return {
                action: "update",
                reason: `forgejo-runner job image differs (config ${String(observed.detail?.["jobImage"])}, want ${parsed.jobImage})`,
            };
        }
        return { action: "noop" };
    },
    apply: async (inputs, _observed, ctx) => {
        const parsed = parse(inputs);
        const session = await executor.connect(sshTarget(parsed));
        try {
            // Jobs need the host's docker CLI + buildx (static binaries), discovered here and bind-mounted in.
            const dockerBin = (await session.exec("command -v docker")).stdout.trim();
            if (dockerBin === "") {
                throw new Error("forgejo-runner: no docker CLI found on the host (CI builds the app image with the host daemon)");
            }
            const buildxPlugin = (
                await session.exec(
                    "find /usr/local/libexec/docker/cli-plugins /usr/libexec/docker/cli-plugins /usr/lib/docker/cli-plugins /usr/local/lib/docker/cli-plugins -name docker-buildx 2>/dev/null | head -1",
                )
            ).stdout.trim();
            if (buildxPlugin === "") {
                throw new Error("forgejo-runner: no docker buildx plugin found on the host (the CI build-push step needs it)");
            }
            await session.exec(`mkdir -p ${CONFIG_DIR}`);
            await session.exec(`cat > ${CONFIG_DIR}/config.yaml <<'CFG'\n${runnerConfig(dockerBin, buildxPlugin, parsed.jobImage)}CFG`);
            await session.exec(`docker rm -f ${CONTAINER} 2>/dev/null || true`);
            const run = await session.exec(
                // --user root avoids a docker-socket permission crash-loop; --config wires both to the host docker.
                `docker run -d --restart unless-stopped --network host --user root --name ${CONTAINER} --label intentic.id=${ctx.id} --label intentic.type=forgejo-runner --label intentic.hash=${ctx.inputsHash ?? ""} ` +
                    `-v ${CONTAINER}-data:/data -v /var/run/docker.sock:/var/run/docker.sock -v ${CONFIG_DIR}/config.yaml:/config.yaml:ro ${parsed.image} ` +
                    `sh -c "forgejo-runner register --no-interactive --config /config.yaml --instance ${parsed.instanceUrl} --token ${parsed.token} && forgejo-runner daemon --config /config.yaml"`,
            );
            if (run.code !== 0) {
                throw new Error(`failed to start forgejo-runner on host: exited ${run.code}: ${run.stderr.trim()}`);
            }
            return {};
        } finally {
            await session.dispose();
        }
    },
    // Parses only the SSH block, so it works from a removed node's inputs or a ListedResource's.
    delete: async (inputs) => {
        const session = await executor.connect(sshTarget(parseInputs(sshSchema, inputs, "forgejo-runner")));
        try {
            await session.exec(`docker rm -f ${CONTAINER} 2>/dev/null || true`);
            await session.exec(`docker volume rm ${CONTAINER}-data 2>/dev/null || true`);
            await session.exec(`rm -rf ${CONFIG_DIR}`);
        } finally {
            await session.dispose();
        }
    },
    list: (sources, ctx) => listStampedContainers(executor, "forgejo-runner", sources, ctx.log),
});
