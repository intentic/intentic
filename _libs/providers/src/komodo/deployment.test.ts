import { expect, test } from "vitest";
import type { SshExecutor } from "../core/ssh.js";
import { createDeploymentProvider } from "./deployment.js";
import type { KomodoApi } from "./komodo-api.js";

const sshForward: SshExecutor = {
    connect: async () => ({
        exec: async () => ({ stdout: "", stderr: "", code: 0 }),
        dispose: async () => {},
        forward: async () => ({ port: 9999, close: async () => {} }),
    }),
};

const NOT_USED = async (): Promise<never> => {
    throw new Error("unused by the deployment provider");
};
const api = (overrides: Partial<KomodoApi>): KomodoApi => ({
    login: async () => "jwt",
    listDeployments: NOT_USED,
    getDeployment: NOT_USED,
    createDeployment: NOT_USED,
    updateDeployment: NOT_USED,
    listUsers: NOT_USED,
    createUser: NOT_USED,
    enableUser: NOT_USED,
    setPermissionOnTarget: NOT_USED,
    listAlerters: NOT_USED,
    getAlerter: NOT_USED,
    createAlerter: NOT_USED,
    updateAlerter: NOT_USED,
    deleteDeployment: NOT_USED,
    deleteUser: NOT_USED,
    deleteAlerter: NOT_USED,
    ...overrides,
});

const ctx = () => ({
    env: {},
    log: () => {},
    id: "my-app.staging",
    output: () => {
        throw new Error("unused");
    },
});

const inputs = {
    owner: "admin",
    repoName: "my-app",
    registry: "127.0.0.1:3000",
    registryAccount: "intentic",
    tag: "staging",
    domain: "staging.example.com",
    internalIp: "10.0.0.5",
    port: 24680,
    address: "203.0.113.10",
    user: "deploy",
    sshKey: "key",
    adminUser: "admin",
    adminPassword: "pw",
    env: {},
};

test("read returns undefined when internalIp is PENDING", async () => {
    expect(await createDeploymentProvider(api({}), sshForward).read({ ...inputs, internalIp: Symbol("PENDING") }, ctx())).toBeUndefined();
});

test("read returns undefined when the deployment does not exist", async () => {
    expect(await createDeploymentProvider(api({ listDeployments: async () => [] }), sshForward).read(inputs, ctx())).toBeUndefined();
});

const observedConfig = {
    server_id: "Local",
    image: { type: "Image", params: { image: "127.0.0.1:3000/admin/my-app:staging" } },
    environment: [],
} as const;

test("read returns the deterministic url + an internalUrl on the host ip when the deployment exists", async () => {
    const observed = await createDeploymentProvider(
        api({ listDeployments: async () => [{ id: "d1", name: "my-app.staging" }], getDeployment: async () => observedConfig }),
        sshForward,
    ).read(inputs, ctx());
    expect(observed?.outputs["url"]).toBe("https://staging.example.com");
    expect(observed?.outputs["internalUrl"]).toMatch(/^http:\/\/10\.0\.0\.5:\d{5}$/);
    expect(observed?.detail).toEqual({ config: observedConfig });
});

test("diff is noop when the live env matches the authored env", () => {
    expect(createDeploymentProvider(api({}), sshForward).diff(inputs, { outputs: {}, detail: { config: observedConfig } })).toEqual({ action: "noop" });
});

test("diff ignores server + image drift (Komodo owns the rollout) — only env drives it", () => {
    const drifted = { ...observedConfig, server_id: "elsewhere", image: { type: "Image", params: { image: "other:tag" } } };
    expect(createDeploymentProvider(api({}), sshForward).diff(inputs, { outputs: {}, detail: { config: drifted } })).toEqual({ action: "noop" });
});

test("diff is update when env drifts", () => {
    const withEnv = { ...inputs, env: { DATABASE_URL: "postgres://desired" } };
    const provider = createDeploymentProvider(api({}), sshForward);
    expect(provider.diff(withEnv, { outputs: {}, detail: { config: observedConfig } }).action).toBe("update");
    const matching = { ...observedConfig, environment: [{ variable: "DATABASE_URL", value: "postgres://desired" }] };
    expect(provider.diff(withEnv, { outputs: {}, detail: { config: matching } })).toEqual({ action: "noop" });
});

test("diff matches Komodo's stored env form (multiline string, spaces around '=')", () => {
    const withEnv = { ...inputs, env: { PORT: "27748" } };
    const stored = { ...observedConfig, environment: "  PORT = 27748\n" };
    expect(createDeploymentProvider(api({}), sshForward).diff(withEnv, { outputs: {}, detail: { config: stored } })).toEqual({ action: "noop" });
});

test("apply creates the deployment from the registry image with poll + auto_update (no build, no deploy)", async () => {
    let created: { name: string; config: Record<string, unknown> } | undefined;
    const provider = createDeploymentProvider(
        api({
            listDeployments: async () => [],
            createDeployment: async (args) => {
                created = args;
            },
        }),
        sshForward,
    );
    const result = await provider.apply(inputs, undefined, ctx());
    expect(result["url"]).toBe("https://staging.example.com");
    expect(created).toMatchObject({
        name: "my-app.staging",
        config: {
            server_id: "Local",
            image: { type: "Image", params: { image: "127.0.0.1:3000/admin/my-app:staging" } },
            image_registry_account: "intentic",
            poll_for_updates: true,
            auto_update: true,
        },
    });
});

test("apply updates the existing deployment (still no build, no deploy)", async () => {
    let updatedId: string | undefined;
    const provider = createDeploymentProvider(
        api({
            listDeployments: async () => [{ id: "d7", name: "my-app.staging" }],
            updateDeployment: async (args) => {
                updatedId = args.id;
            },
        }),
        sshForward,
    );
    await provider.apply(inputs, undefined, ctx());
    expect(updatedId).toBe("d7");
});

test("malformed inputs are rejected", async () => {
    await expect(createDeploymentProvider(api({}), sshForward).read({ ...inputs, internalIp: 5 }, ctx())).rejects.toThrow(/deployment inputs malformed/);
});
