import { expect, test } from "vitest";
import type { SshExecutor, SshResult, SshSession } from "../core/ssh.js";
import { createForgejoRunnerProvider } from "./forgejo-runner.js";

const res = (stdout: string, code = 0): SshResult => ({ stdout, stderr: "", code });

const IMAGE = "data.forgejo.org/forgejo/runner:6.4.0@sha256:aaaa";
const JOB_IMAGE = "data.forgejo.org/oci/node:20-bullseye@sha256:bbbb";

const fakeSsh = (
    opts: { running?: boolean; registered?: boolean; runFails?: boolean; image?: string; jobImage?: string } = {},
): { executor: SshExecutor; commands: string[] } => {
    const commands: string[] = [];
    const session: SshSession = {
        exec: async (command) => {
            commands.push(command);
            if (command.includes(".Config.Labels")) {
                return res("");
            }
            if (command.includes("docker inspect")) {
                return res(opts.image ?? IMAGE);
            }
            if (command.includes("config.yaml 2>/dev/null")) {
                return res(`  labels: [ "docker:docker://${opts.jobImage ?? JOB_IMAGE}" ]`);
            }
            if (command.includes("docker ps")) {
                return res(opts.running ? "intentic-forgejo-runner" : "");
            }
            if (command.includes("cat /data/.runner")) {
                return res(opts.registered ? '{"address":"https://git.example.com"}' : "");
            }
            if (command.includes("command -v docker")) {
                return res("/usr/local/bin/docker");
            }
            if (command.includes("docker-buildx")) {
                return res("/usr/local/libexec/docker/cli-plugins/docker-buildx");
            }
            if (command.includes("docker run")) {
                return res("id", opts.runFails ? 1 : 0);
            }
            return res("");
        },
        dispose: async () => {},
    };
    return { executor: { connect: async () => session }, commands };
};

const unreachable: SshExecutor = {
    connect: async () => {
        throw new Error("ECONNREFUSED");
    },
};

const ctx = (log: (message: string) => void = () => {}) => ({
    env: {},
    log,
    id: "host-git-runner",
    output: () => {
        throw new Error("unused");
    },
});

const inputs = {
    server: "host",
    address: "203.0.113.10",
    user: "deploy",
    sshKey: "key",
    instanceUrl: "https://git.example.com",
    token: "tok-123",
    image: IMAGE,
    jobImage: JOB_IMAGE,
};

test("read returns undefined when the host is unreachable over SSH", async () => {
    expect(await createForgejoRunnerProvider(unreachable).read(inputs, ctx())).toBeUndefined();
});

test("read returns undefined when the runner container is not running", async () => {
    expect(await createForgejoRunnerProvider(fakeSsh({ running: false }).executor).read(inputs, ctx())).toBeUndefined();
});

test("read returns undefined when the runner is not registered to the desired instance", async () => {
    expect(await createForgejoRunnerProvider(fakeSsh({ running: true, registered: false }).executor).read(inputs, ctx())).toBeUndefined();
});

test("read returns empty outputs plus the observed runner + job images when running and registered", async () => {
    expect(await createForgejoRunnerProvider(fakeSsh({ running: true, registered: true }).executor).read(inputs, ctx())).toEqual({
        outputs: {},
        detail: { image: IMAGE, jobImage: JOB_IMAGE },
    });
});

test("diff is noop when both the runner and job images match the desired pins", () => {
    const observed = { outputs: {}, detail: { image: IMAGE, jobImage: JOB_IMAGE } };
    expect(createForgejoRunnerProvider(fakeSsh().executor).diff(inputs, observed)).toEqual({ action: "noop" });
});

test("diff is update when the runner image differs", () => {
    const observed = { outputs: {}, detail: { image: "data.forgejo.org/forgejo/runner:6.0.0@sha256:cccc", jobImage: JOB_IMAGE } };
    expect(createForgejoRunnerProvider(fakeSsh().executor).diff(inputs, observed).action).toBe("update");
});

test("diff is update when the job image in config differs", () => {
    const observed = { outputs: {}, detail: { image: IMAGE, jobImage: "data.forgejo.org/oci/node:18-bullseye@sha256:dddd" } };
    expect(createForgejoRunnerProvider(fakeSsh().executor).diff(inputs, observed).action).toBe("update");
});

test("apply registers against the instance + token and starts the daemon, returning empty outputs", async () => {
    const ssh = fakeSsh();
    expect(await createForgejoRunnerProvider(ssh.executor).apply(inputs, undefined, ctx())).toEqual({});
    expect(
        ssh.commands.some(
            (c) =>
                c.includes("docker run") &&
                c.includes("--config /config.yaml") &&
                c.includes("--instance https://git.example.com") &&
                c.includes("--token tok-123") &&
                c.includes("intentic.id=host-git-runner"),
        ),
    ).toBe(true);
    // The runner config wires the host docker into job containers (socket auto-mounted + the host CLI/buildx bind-mounted).
    expect(ssh.commands.some((c) => c.includes("config.yaml") && c.includes("docker_host: automount") && c.includes("docker-buildx"))).toBe(true);
});

test("apply throws when docker run exits non-zero", async () => {
    await expect(createForgejoRunnerProvider(fakeSsh({ runFails: true }).executor).apply(inputs, undefined, ctx())).rejects.toThrow(
        /failed to start forgejo-runner/,
    );
});

test("apply propagates an SSH connection failure", async () => {
    await expect(createForgejoRunnerProvider(unreachable).apply(inputs, undefined, ctx())).rejects.toThrow("ECONNREFUSED");
});

test("malformed inputs are rejected", async () => {
    await expect(createForgejoRunnerProvider(fakeSsh().executor).read({ ...inputs, token: 5 }, ctx())).rejects.toThrow(
        /forgejo-runner inputs malformed/,
    );
});
