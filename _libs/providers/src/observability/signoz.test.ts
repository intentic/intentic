import { expect, test } from "vitest";
import type { SshExecutor, SshResult, SshSession } from "../core/ssh.js";
import { createSignozProvider } from "./signoz.js";

const res = (stdout: string, code = 0): SshResult => ({ stdout, stderr: "", code });

const CLICKHOUSE_IMAGE = "clickhouse/clickhouse-server:25.5.6@sha256:aaaa";
const SIGNOZ_IMAGE = "signoz/signoz:v0.129.0@sha256:bbbb";
const OTEL_IMAGE = "signoz/signoz-otel-collector:v0.144.5@sha256:cccc";
const ZOOKEEPER_IMAGE = "signoz/zookeeper:3.7.1@sha256:dddd";
// The service=image lines `docker inspect` reports for the running compose project (the one-shot
// init-clickhouse + telemetrystore-migrator have exited, so they are absent; the migrator's image tracks the
// otel collector's).
const DEFAULT_IMAGES = { zookeeper: ZOOKEEPER_IMAGE, clickhouse: CLICKHOUSE_IMAGE, signoz: SIGNOZ_IMAGE, "otel-collector": OTEL_IMAGE };
const composeImages = (images: Record<string, string>): string =>
    Object.entries(images)
        .map(([service, image]) => `${service}=${image}`)
        .join("\n");

// Drives the signoz provider entirely over SSH: docker ps reports the UI container, the project inspect
// reports each service's image, the wget reports liveness, docker compose up can be made to fail, and the
// register curl reports an HTTP status.
const fakeSsh = (
    opts: { running?: boolean; upFails?: boolean; healthy?: boolean; register?: string; images?: Record<string, string> } = {},
): { executor: SshExecutor; commands: string[] } => {
    const commands: string[] = [];
    const session: SshSession = {
        exec: async (command) => {
            commands.push(command);
            if (command.includes("com.docker.compose.project")) {
                return res(opts.running ? composeImages(opts.images ?? DEFAULT_IMAGES) : "");
            }
            if (command.includes("docker ps")) {
                return res(opts.running ? "intentic-signoz" : "");
            }
            if (command.includes("wget")) {
                return res("", opts.healthy ? 0 : 1);
            }
            if (command.includes("docker compose")) {
                return res("up", opts.upFails ? 1 : 0);
            }
            if (command.includes("curl")) {
                return res(opts.register ?? "200");
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
    id: "obs",
    output: () => {
        throw new Error("unused");
    },
});

const inputs = {
    server: "host",
    address: "203.0.113.10",
    user: "deploy",
    sshKey: "key",
    internalIp: "10.0.0.5",
    domain: "signoz.example.com",
    adminUser: "intentic@example.com",
    adminPassword: "pw",
    clickhouseImage: CLICKHOUSE_IMAGE,
    signozImage: SIGNOZ_IMAGE,
    otelImage: OTEL_IMAGE,
    zookeeperImage: ZOOKEEPER_IMAGE,
};

const outputs = { url: "https://signoz.example.com", internalUrl: "http://10.0.0.5:8080", otlpEndpoint: "http://10.0.0.5:4318" };

test("read returns undefined when the host is unreachable over SSH", async () => {
    expect(await createSignozProvider(unreachable).read(inputs, ctx())).toBeUndefined();
});

test("read returns undefined when the UI container is not running", async () => {
    expect(await createSignozProvider(fakeSsh({ running: false }).executor).read(inputs, ctx())).toBeUndefined();
});

test("read returns undefined when the UI is not yet healthy", async () => {
    expect(await createSignozProvider(fakeSsh({ running: true, healthy: false }).executor).read(inputs, ctx())).toBeUndefined();
});

test("read returns the deterministic url/internalUrl/otlpEndpoint plus the observed service images when running and healthy", async () => {
    const provider = createSignozProvider(fakeSsh({ running: true, healthy: true }).executor);
    expect(await provider.read(inputs, ctx())).toEqual({ outputs, detail: { images: DEFAULT_IMAGES } });
});

test("diff is noop when every long-running service runs on its desired image", () => {
    expect(createSignozProvider(fakeSsh().executor).diff(inputs, { outputs: {}, detail: { images: DEFAULT_IMAGES } })).toEqual({ action: "noop" });
});

test("diff is update when a service image differs from the desired pin (incl. zookeeper)", () => {
    const observed = { outputs: {}, detail: { images: { ...DEFAULT_IMAGES, zookeeper: "signoz/zookeeper:3.7.0@sha256:eeee" } } };
    expect(createSignozProvider(fakeSsh().executor).diff(inputs, observed).action).toBe("update");
});

test("apply writes the compose (pinned images incl. zookeeper) + the clickhouse/otel config files + a once-guarded JWT env, brings the stack up, seeds the admin, and returns outputs", async () => {
    const ssh = fakeSsh({ healthy: true });
    const result = await createSignozProvider(ssh.executor).apply(inputs, undefined, ctx());
    expect(result).toEqual(outputs);
    // The pinned image refs are inlined into the compose YAML, so a bump lands here.
    expect(
        ssh.commands.some(
            (c) =>
                c.includes("cat > /opt/intentic/signoz/compose.yaml") &&
                c.includes(SIGNOZ_IMAGE) &&
                c.includes(CLICKHOUSE_IMAGE) &&
                c.includes(ZOOKEEPER_IMAGE),
        ),
    ).toBe(true);
    expect(ssh.commands.some((c) => c.includes("cat > /opt/intentic/signoz/otel-collector-config.yaml"))).toBe(true);
    expect(ssh.commands.some((c) => c.includes("cat > /opt/intentic/signoz/cluster.xml"))).toBe(true);
    expect(ssh.commands.some((c) => c.includes("cat > /opt/intentic/signoz/custom-function.xml"))).toBe(true);
    expect(ssh.commands.some((c) => c.includes("cat > /opt/intentic/signoz/init-clickhouse.sh") && c.includes("histogramQuantile"))).toBe(true);
    // The JWT signing secret is written write-once (test -f guard), generated host-side.
    expect(ssh.commands.some((c) => c.includes("test -f /opt/intentic/signoz/.env") && c.includes("SIGNOZ_TOKENIZER_JWT_SECRET"))).toBe(true);
    expect(ssh.commands.some((c) => c.includes("docker compose -p signoz") && c.includes("up -d"))).toBe(true);
    // The admin is seeded against the register API with the resolved email + password.
    expect(ssh.commands.some((c) => c.includes("/api/v1/register") && c.includes("intentic@example.com") && c.includes('"password":"pw"'))).toBe(
        true,
    );
});

test("apply tolerates an already-seeded admin (register returns non-200), logging instead of failing", async () => {
    const logs: string[] = [];
    const ssh = fakeSsh({ healthy: true, register: "409" });
    await createSignozProvider(ssh.executor).apply(
        inputs,
        undefined,
        ctx((m) => logs.push(m)),
    );
    expect(logs.some((m) => m.includes("register returned 409"))).toBe(true);
});

test("apply throws when docker compose up exits non-zero", async () => {
    const ssh = fakeSsh({ upFails: true });
    await expect(createSignozProvider(ssh.executor).apply(inputs, undefined, ctx())).rejects.toThrow(/failed to bring up signoz/);
});

test("apply propagates an SSH connection failure", async () => {
    await expect(createSignozProvider(unreachable).apply(inputs, undefined, ctx())).rejects.toThrow("ECONNREFUSED");
});

test("malformed inputs are rejected", async () => {
    await expect(createSignozProvider(fakeSsh().executor).read({ ...inputs, internalIp: 5 }, ctx())).rejects.toThrow(/signoz inputs malformed/);
});
