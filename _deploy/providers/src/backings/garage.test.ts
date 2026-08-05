import { expect, test } from "vitest";
import type { SshExecutor, SshResult, SshSession } from "../core/ssh.js";
import { createGarageProvider } from "./garage.js";
import { createGarageBucketProvider } from "./garage-bucket.js";

const res = (stdout: string, code = 0): SshResult => ({ stdout, stderr: "", code });

const IMAGE = "dxflrs/garage:v2.3.0@sha256:aaaa";

// Drives the garage instance provider: `garage status` reports readiness, docker inspect reports the image,
// the layout commands drive the one-time bootstrap, and docker compose up can be made to fail.
const fakeSsh = (
    opts: { ready?: boolean; upFails?: boolean; image?: string; layout?: string } = {},
): { executor: SshExecutor; commands: string[] } => {
    const commands: string[] = [];
    const session: SshSession = {
        exec: async (command) => {
            commands.push(command);
            if (command.includes("garage status")) {
                return res("", opts.ready ? 0 : 1);
            }
            if (command.includes("garage node id")) {
                return res("nodehex@10.0.0.5:3901");
            }
            if (command.includes("garage layout show")) {
                return res(opts.layout ?? "");
            }
            if (command.includes(".Config.Labels")) {
                return res("");
            }
            if (command.includes("docker inspect")) {
                return res(opts.image ?? IMAGE);
            }
            if (command.includes("docker ps -q")) {
                return res(opts.ready ? "cid123" : "");
            }
            if (command.includes("docker compose")) {
                return res("up", opts.upFails ? 1 : 0);
            }
            return res("");
        },
        dispose: async () => {},
    };
    return { executor: { connect: async () => session }, commands };
};

const ctx = (id = "store", log: (message: string) => void = () => {}) => ({ env: {}, log, id, output: () => undefined });

const inputs = {
    server: "host",
    address: "203.0.113.10",
    user: "deploy",
    sshKey: "key",
    internalIp: "10.0.0.5",
    publishPort: 40555,
    region: "garage",
    image: IMAGE,
};
const outputs = { internalEndpoint: "http://10.0.0.5:40555", endpoint: "http://10.0.0.5:40555" };

test("instance read returns undefined until garage status passes", async () => {
    expect(await createGarageProvider(fakeSsh({ ready: false }).executor).read(inputs, ctx())).toBeUndefined();
});

test("instance read returns the endpoints + observed image when ready; endpoint is public when a domain is set", async () => {
    expect(await createGarageProvider(fakeSsh({ ready: true }).executor).read(inputs, ctx())).toEqual({ outputs, detail: { image: IMAGE } });
    const exposed = await createGarageProvider(fakeSsh({ ready: true }).executor).read({ ...inputs, domain: "s3.example.com" }, ctx());
    expect((exposed as { outputs: Record<string, unknown> }).outputs["endpoint"]).toBe("https://s3.example.com");
});

test("instance diff is noop on the desired image and update on drift", () => {
    const provider = createGarageProvider(fakeSsh().executor);
    expect(provider.diff(inputs, { outputs: {}, detail: { image: IMAGE } })).toEqual({ action: "noop" });
    expect(provider.diff(inputs, { outputs: {}, detail: { image: "dxflrs/garage:v2.0.0@sha256:bbbb" } }).action).toBe("update");
});

test("instance apply writes compose (pinned image + S3 port) + garage.toml + a once-guarded rpc secret, brings it up, and assigns a layout", async () => {
    const ssh = fakeSsh({ ready: true });
    const result = await createGarageProvider(ssh.executor).apply(inputs, undefined, ctx());
    expect(result).toEqual(outputs);
    expect(
        ssh.commands.some((c) => c.includes("cat > /opt/intentic/garage/store/compose.yaml") && c.includes(IMAGE) && c.includes('"40555:3900"')),
    ).toBe(true);
    expect(ssh.commands.some((c) => c.includes("cat > /opt/intentic/garage/store/garage.toml") && c.includes("rpc_secret_file"))).toBe(true);
    expect(ssh.commands.some((c) => c.includes("test -f /opt/intentic/garage/store/rpc_secret") && c.includes("openssl rand -hex 32"))).toBe(true);
    expect(ssh.commands.some((c) => c.includes("docker compose") && c.includes("up -d"))).toBe(true);
    expect(ssh.commands.some((c) => c.includes("garage layout assign") && c.includes("nodehex"))).toBe(true);
    expect(ssh.commands.some((c) => c.includes("garage layout apply"))).toBe(true);
});

test("instance apply skips the layout assign when the node already holds a role", async () => {
    const ssh = fakeSsh({ ready: true, layout: "Role for node nodehex: zone=dc1 capacity=1G" });
    await createGarageProvider(ssh.executor).apply(inputs, undefined, ctx());
    expect(ssh.commands.some((c) => c.includes("garage layout assign"))).toBe(false);
});

// --- The per-app binding provider (garage-bucket) ---

const keyInfo = "Key name: app\nKey ID: GKtestaccesskey\nSecret key: deadbeefsecret\n";
const bindingSsh = (opts: { container?: boolean; bucket?: boolean } = {}): { executor: SshExecutor; commands: string[] } => {
    const commands: string[] = [];
    const session: SshSession = {
        exec: async (command) => {
            commands.push(command);
            if (command.includes("docker ps -q")) {
                return res(opts.container === false ? "" : "cid123");
            }
            if (command.includes("bucket info")) {
                return res("", opts.bucket ? 0 : 1);
            }
            if (command.includes("key info")) {
                return res(keyInfo);
            }
            return res("");
        },
        dispose: async () => {},
    };
    return { executor: { connect: async () => session }, commands };
};

const bindingInputs = {
    address: "203.0.113.10",
    user: "deploy",
    sshKey: "key",
    instance: "store",
    endpoint: "http://10.0.0.5:40555",
    bucket: "app",
    keyName: "app",
};
const bindingOutputs = { endpoint: "http://10.0.0.5:40555", accessKey: "GKtestaccesskey", secretKey: "deadbeefsecret", bucket: "app" };

test("binding read returns undefined when the bucket does not exist yet", async () => {
    expect(await createGarageBucketProvider(bindingSsh({ bucket: false }).executor).read(bindingInputs, ctx("app-uses-store"))).toBeUndefined();
});

test("binding read returns the endpoint + the read-back key pair once the bucket exists", async () => {
    expect(await createGarageBucketProvider(bindingSsh({ bucket: true }).executor).read(bindingInputs, ctx("app-uses-store"))).toEqual({
        outputs: bindingOutputs,
    });
});

test("binding apply creates the bucket + key, grants read+write, and returns the key pair", async () => {
    const ssh = bindingSsh({ bucket: true });
    const result = await createGarageBucketProvider(ssh.executor).apply(bindingInputs, undefined, ctx("app-uses-store"));
    expect(result).toEqual(bindingOutputs);
    expect(ssh.commands.some((c) => c.includes("garage bucket create app"))).toBe(true);
    expect(ssh.commands.some((c) => c.includes("garage key create app"))).toBe(true);
    expect(ssh.commands.some((c) => c.includes("bucket allow --read --write app --key app"))).toBe(true);
});

test("binding apply throws when the instance is not running", async () => {
    await expect(
        createGarageBucketProvider(bindingSsh({ container: false }).executor).apply(bindingInputs, undefined, ctx("app-uses-store")),
    ).rejects.toThrow(/instance "store" is not running/);
});

test("binding delete drops the bucket and key", async () => {
    const ssh = bindingSsh({ bucket: true });
    await createGarageBucketProvider(ssh.executor).delete!(bindingInputs, ctx("app-uses-store"));
    expect(ssh.commands.some((c) => c.includes("bucket delete --yes app"))).toBe(true);
    expect(ssh.commands.some((c) => c.includes("key delete --yes app"))).toBe(true);
});
