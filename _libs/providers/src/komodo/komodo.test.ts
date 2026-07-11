import { expect, test } from "vitest";
import type { SshExecutor, SshResult, SshSession } from "../core/ssh.js";
import { createKomodoProvider } from "./komodo.js";

const res = (stdout: string, code = 0): SshResult => ({ stdout, stderr: "", code });

const CORE_IMAGE = "ghcr.io/moghtech/komodo-core:2.1.0@sha256:aaaa";
const PERIPHERY_IMAGE = "ghcr.io/moghtech/komodo-periphery:2.1.0@sha256:bbbb";
const FERRETDB_IMAGE = "ghcr.io/ferretdb/ferretdb:2.7.0@sha256:cccc";
const POSTGRES_IMAGE = "ghcr.io/ferretdb/postgres-documentdb:17-0.107.0-ferretdb-2.7.0@sha256:dddd";
// The service=image lines `docker inspect` reports for the running compose project, mirroring runningImages.
const composeImages = (images: Record<string, string>): string =>
    Object.entries(images)
        .map(([service, image]) => `${service}=${image}`)
        .join("\n");
const DEFAULT_IMAGES = { postgres: POSTGRES_IMAGE, ferretdb: FERRETDB_IMAGE, core: CORE_IMAGE, periphery: PERIPHERY_IMAGE };

// Drives the komodo provider entirely over SSH: docker ps reports the core container, the project inspect
// reports each service's image, the /api/health wget reports liveness, and docker compose up can be made to fail.
const fakeSsh = (
    opts: { running?: boolean; upFails?: boolean; healthy?: boolean; images?: Record<string, string> } = {},
): { executor: SshExecutor; commands: string[] } => {
    const commands: string[] = [];
    const session: SshSession = {
        exec: async (command) => {
            commands.push(command);
            if (command.includes("com.docker.compose.project")) {
                return res(opts.running ? composeImages(opts.images ?? DEFAULT_IMAGES) : "");
            }
            if (command.includes("docker ps")) {
                return res(opts.running ? "intentic-komodo-core" : "");
            }
            if (command.includes("wget")) {
                return res("", opts.healthy ? 0 : 1);
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

const unreachable: SshExecutor = {
    connect: async () => {
        throw new Error("ECONNREFUSED");
    },
};

const ctx = (log: (message: string) => void = () => {}) => ({
    env: {},
    log,
    id: "host-deploy",
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
    domain: "deploy.example.com",
    adminUser: "intentic",
    adminPassword: "pw",
    gitUrl: "http://10.0.0.5:3000",
    gitAccount: "intentic",
    gitToken: "gtok-456",
    registry: "127.0.0.1:3000",
    registryUser: "intentic",
    registryToken: "ptok-789",
    coreImage: CORE_IMAGE,
    peripheryImage: PERIPHERY_IMAGE,
    ferretdbImage: FERRETDB_IMAGE,
    postgresImage: POSTGRES_IMAGE,
};

test("read returns undefined when the host is unreachable over SSH", async () => {
    expect(await createKomodoProvider(unreachable).read(inputs, ctx())).toBeUndefined();
});

test("read returns undefined when the core container is not running", async () => {
    expect(await createKomodoProvider(fakeSsh({ running: false }).executor).read(inputs, ctx())).toBeUndefined();
});

test("read returns undefined when core is not yet healthy", async () => {
    const provider = createKomodoProvider(fakeSsh({ running: true, healthy: false }).executor);
    expect(await provider.read(inputs, ctx())).toBeUndefined();
});

test("read returns the deterministic url/internalUrl plus the observed service images when running and healthy", async () => {
    const provider = createKomodoProvider(fakeSsh({ running: true, healthy: true }).executor);
    expect(await provider.read(inputs, ctx())).toEqual({
        outputs: { url: "https://deploy.example.com", internalUrl: "http://10.0.0.5:9120" },
        detail: { images: DEFAULT_IMAGES },
    });
});

test("diff is noop when every service runs on its desired image", () => {
    expect(createKomodoProvider(fakeSsh().executor).diff(inputs, { outputs: {}, detail: { images: DEFAULT_IMAGES } })).toEqual({ action: "noop" });
});

test("diff is update when a service image differs from the desired pin", () => {
    const observed = { outputs: {}, detail: { images: { ...DEFAULT_IMAGES, core: "ghcr.io/moghtech/komodo-core:2.0.0@sha256:eeee" } } };
    expect(createKomodoProvider(fakeSsh().executor).diff(inputs, observed).action).toBe("update");
});

test("apply writes compose + a once-guarded env, brings the stack up, waits for health, and returns outputs", async () => {
    const ssh = fakeSsh({ healthy: true });
    const result = await createKomodoProvider(ssh.executor).apply(inputs, undefined, ctx());
    expect(result).toEqual({ url: "https://deploy.example.com", internalUrl: "http://10.0.0.5:9120" });
    expect(ssh.commands.some((c) => c.includes("cat > /opt/intentic/komodo/compose.yaml"))).toBe(true);
    // The git-provider account is registered against Forgejo's INTERNAL authority (derived from forgejoUrl),
    // over plain http, so Komodo clones host-locally rather than chasing the unresolvable public name.
    expect(
        ssh.commands.some(
            (c) =>
                c.includes("cat > /opt/intentic/komodo/config.toml") &&
                c.includes('domain = "10.0.0.5:3000"') &&
                c.includes("https = false") &&
                c.includes('token = "gtok-456"'),
        ),
    ).toBe(true);
    // The docker-registry account lets Komodo pull the private app images CI pushes to the Forgejo registry.
    expect(
        ssh.commands.some(
            (c) =>
                c.includes("cat > /opt/intentic/komodo/config.toml") && c.includes('domain = "127.0.0.1:3000"') && c.includes('token = "ptok-789"'),
        ),
    ).toBe(true);
    // The resource poll interval is baked into the once-guarded .env so auto_update can roll out new images.
    expect(ssh.commands.some((c) => c.includes("test -f /opt/intentic/komodo/.env") && c.includes("KOMODO_RESOURCE_POLL_INTERVAL=1-min"))).toBe(true);
    expect(ssh.commands.some((c) => c.includes("docker compose -p komodo") && c.includes("up -d"))).toBe(true);
});

test("a guarded update snapshots the postgres/keys/ferretdb volumes before recreating; the happy path issues no restore", async () => {
    const ssh = fakeSsh({ healthy: true });
    const observed = { outputs: {}, detail: { images: { ...DEFAULT_IMAGES, core: "ghcr.io/moghtech/komodo-core:2.0.0@sha256:old" } } };
    await createKomodoProvider(ssh.executor).apply(
        { ...inputs, guardRepo: "s3:s3.example.com/bucket", resticImage: "restic/restic:0.19.0@sha256:r" },
        observed,
        ctx(),
    );
    for (const volume of ["komodo_postgres-data", "komodo_keys", "komodo_ferretdb-state"]) {
        expect(ssh.commands.some((c) => c.includes(`backup /v --tag intentic-preupdate-intentic-komodo-core`) && c.includes(volume))).toBe(true);
    }
    expect(ssh.commands.some((c) => c.includes("restore latest --tag"))).toBe(false);
});

test("a non-guarded apply issues no restic commands (Phase-1 behavior)", async () => {
    const ssh = fakeSsh({ healthy: true });
    await createKomodoProvider(ssh.executor).apply(inputs, undefined, ctx());
    expect(ssh.commands.some((c) => c.includes("restic") || c.includes("intentic-preupdate"))).toBe(false);
});

test("apply throws when docker compose up exits non-zero", async () => {
    const ssh = fakeSsh({ upFails: true });
    await expect(createKomodoProvider(ssh.executor).apply(inputs, undefined, ctx())).rejects.toThrow(/failed to bring up komodo/);
});

test("apply propagates an SSH connection failure", async () => {
    await expect(createKomodoProvider(unreachable).apply(inputs, undefined, ctx())).rejects.toThrow("ECONNREFUSED");
});

test("malformed inputs are rejected", async () => {
    await expect(createKomodoProvider(fakeSsh().executor).read({ ...inputs, registry: 5 }, ctx())).rejects.toThrow(/komodo inputs malformed/);
});
