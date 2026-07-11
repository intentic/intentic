import { expect, test } from "vitest";
import type { SshExecutor, SshResult, SshSession } from "../core/ssh.js";
import { createAuthentikProvider } from "./authentik.js";
import type { AuthentikApi, AuthentikClientSpec } from "./authentik-api.js";
import { createAuthentikClientProvider } from "./authentik-client.js";

const res = (stdout: string, code = 0): SshResult => ({ stdout, stderr: "", code });

const IMAGE = "ghcr.io/goauthentik/server:2025.8.4@sha256:aaaa";
const PG = "postgres:17.6-alpine@sha256:bbbb";
const REDIS = "valkey/valkey:8.1.1-alpine@sha256:cccc";

// Drives the authentik instance provider: the host-side wget health probe reports readiness, docker inspect
// reports the server image, and docker compose up can be made to fail.
const fakeSsh = (opts: { ready?: boolean; upFails?: boolean; image?: string } = {}): { executor: SshExecutor; commands: string[] } => {
    const commands: string[] = [];
    const session: SshSession = {
        exec: async (command) => {
            commands.push(command);
            if (command.includes("wget")) {
                return res("", opts.ready ? 0 : 1);
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

const ctx = (id = "auth", log: (message: string) => void = () => {}) => ({ env: {}, log, id, output: () => undefined });

const inputs = {
    server: "host",
    address: "203.0.113.10",
    user: "deploy",
    sshKey: "key",
    internalIp: "10.0.0.5",
    publishPort: 49000,
    domain: "auth.example.com",
    secretKey: "sk",
    bootstrapToken: "btok",
    bootstrapPassword: "bpw",
    dbPassword: "dbpw",
    image: IMAGE,
    pgImage: PG,
    redisImage: REDIS,
};
const outputs = { url: "https://auth.example.com", issuerUrl: "https://auth.example.com/application/o/", internalUrl: "http://10.0.0.5:49000" };

test("instance read returns the deterministic urls + observed image once the server is healthy", async () => {
    expect(await createAuthentikProvider(fakeSsh({ ready: true }).executor).read(inputs, ctx())).toEqual({ outputs, detail: { image: IMAGE } });
    expect(await createAuthentikProvider(fakeSsh({ ready: false }).executor).read(inputs, ctx())).toBeUndefined();
});

test("instance diff is noop on the desired server image and update on drift", () => {
    const provider = createAuthentikProvider(fakeSsh().executor);
    expect(provider.diff(inputs, { outputs: {}, detail: { image: IMAGE } })).toEqual({ action: "noop" });
    expect(provider.diff(inputs, { outputs: {}, detail: { image: "ghcr.io/goauthentik/server:2025.6.0@sha256:old" } }).action).toBe("update");
});

test("instance apply writes a 4-service compose (server/worker/pinned pg+redis) + a once-guarded .env, and brings it up", async () => {
    const ssh = fakeSsh({ ready: true });
    expect(await createAuthentikProvider(ssh.executor).apply(inputs, undefined, ctx())).toEqual(outputs);
    expect(
        ssh.commands.some(
            (c) =>
                c.includes("cat > /opt/intentic/authentik/auth/compose.yaml") &&
                c.includes(IMAGE) &&
                c.includes(PG) &&
                c.includes(REDIS) &&
                c.includes('"49000:9000"'),
        ),
    ).toBe(true);
    // Secret key + bootstrap token go into the write-once .env (test -f guard), not the rewritable compose.
    expect(
        ssh.commands.some(
            (c) =>
                c.includes("test -f /opt/intentic/authentik/auth/.env") &&
                c.includes("AUTHENTIK_SECRET_KEY=sk") &&
                c.includes("AUTHENTIK_BOOTSTRAP_TOKEN=btok"),
        ),
    ).toBe(true);
    expect(ssh.commands.some((c) => c.includes("docker compose") && c.includes("up -d"))).toBe(true);
});

// --- The per-app binding provider (authentik-client), over a fake AuthentikApi ---

const fakeApi = (opts: { exists?: boolean } = {}): { api: AuthentikApi; ensured: AuthentikClientSpec[]; deleted: string[] } => {
    const ensured: AuthentikClientSpec[] = [];
    const deleted: string[] = [];
    return {
        ensured,
        deleted,
        api: {
            findApplication: async () => opts.exists ?? false,
            ensureClient: async (spec) => {
                ensured.push(spec);
            },
            deleteClient: async ({ slug }) => {
                deleted.push(slug);
            },
        },
    };
};

const clientInputs = {
    authentikUrl: "https://auth.example.com",
    bootstrapToken: "btok",
    domain: "auth.example.com",
    slug: "app",
    clientId: "cid",
    clientSecret: "csec",
    redirectDomains: ["app.example.com"],
};
const clientOutputs = { issuer: "https://auth.example.com/application/o/app/", clientId: "cid", clientSecret: "csec" };

test("client read returns undefined until the application exists, then the issuer + credentials", async () => {
    expect(await createAuthentikClientProvider(fakeApi({ exists: false }).api).read(clientInputs, ctx("app-uses-auth"))).toBeUndefined();
    expect(await createAuthentikClientProvider(fakeApi({ exists: true }).api).read(clientInputs, ctx("app-uses-auth"))).toEqual({
        outputs: clientOutputs,
    });
});

test("client apply ensures the OIDC client with the generated credentials + redirect domains, returning the issuer", async () => {
    const fake = fakeApi();
    const result = await createAuthentikClientProvider(fake.api).apply(clientInputs, undefined, ctx("app-uses-auth"));
    expect(result).toEqual(clientOutputs);
    expect(fake.ensured).toHaveLength(1);
    expect(fake.ensured[0]).toMatchObject({ slug: "app", clientId: "cid", clientSecret: "csec", redirectDomains: ["app.example.com"] });
});

test("client delete removes the application + provider by slug", async () => {
    const fake = fakeApi({ exists: true });
    await createAuthentikClientProvider(fake.api).delete!(clientInputs, ctx("app-uses-auth"));
    expect(fake.deleted).toEqual(["app"]);
});
