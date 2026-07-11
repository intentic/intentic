import { expect, test } from "vitest";
import type { AlerterConfig, KomodoApi } from "./komodo-api.js";
import { createKomodoNotifyProvider } from "./komodo-notify.js";

const NOT_USED = async (): Promise<never> => {
    throw new Error("unused by the komodo-notify provider");
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
    id: "my-app-notify",
    output: () => {
        throw new Error("unused");
    },
});

const inputs = {
    komodoUrl: "https://deploy.example.com",
    adminUser: "admin",
    adminPassword: "pw",
    targets: ["my-app.staging", "my-app.production"],
    webhook: "https://discord.test/wh",
    events: ["deploy"],
};

const config = (over: Partial<AlerterConfig> = {}): AlerterConfig => ({
    enabled: true,
    endpoint: { type: "Discord", params: { url: "https://discord.test/wh" } },
    alert_types: ["DeploymentStateChange"],
    resources: [
        { type: "Deployment", id: "my-app.staging" },
        { type: "Deployment", id: "my-app.production" },
    ],
    except_resources: [],
    ...over,
});

test("read returns undefined when komodoUrl is PENDING", async () => {
    expect(await createKomodoNotifyProvider(api({})).read({ ...inputs, komodoUrl: 42 }, ctx())).toBeUndefined();
});

test("read returns undefined when the alerter does not exist", async () => {
    expect(await createKomodoNotifyProvider(api({ listAlerters: async () => [] })).read(inputs, ctx())).toBeUndefined();
});

test("read returns the alerter config detail when it exists", async () => {
    const provider = createKomodoNotifyProvider(
        api({ listAlerters: async () => [{ id: "a1", name: "my-app-notify" }], getAlerter: async () => config() }),
    );
    expect(await provider.read(inputs, ctx())).toEqual({ outputs: {}, detail: { config: config() } });
});

test("diff is noop when url + scope match, update otherwise", () => {
    const provider = createKomodoNotifyProvider(api({}));
    expect(provider.diff(inputs, { outputs: {}, detail: { config: config() } })).toEqual({ action: "noop" });
    expect(provider.diff(inputs, { outputs: {}, detail: { config: config({ enabled: false }) } }).action).toBe("update");
    expect(
        provider.diff(inputs, { outputs: {}, detail: { config: config({ endpoint: { type: "Discord", params: { url: "https://other" } } }) } })
            .action,
    ).toBe("update");
    expect(
        provider.diff(inputs, { outputs: {}, detail: { config: config({ resources: [{ type: "Deployment", id: "my-app.staging" }] }) } }).action,
    ).toBe("update");
});

test("apply creates a Discord alerter scoped to the app's deployments", async () => {
    let created: { name: string; config: AlerterConfig } | undefined;
    const provider = createKomodoNotifyProvider(
        api({
            listAlerters: async () => [],
            createAlerter: async (args) => {
                created = args;
            },
        }),
    );
    expect(await provider.apply(inputs, undefined, ctx())).toEqual({});
    expect(created?.name).toBe("my-app-notify");
    expect(created?.config.endpoint).toEqual({ type: "Discord", params: { url: "https://discord.test/wh" } });
    expect(created?.config.resources).toEqual([
        { type: "Deployment", id: "my-app.staging" },
        { type: "Deployment", id: "my-app.production" },
    ]);
});

test("apply updates the existing alerter rather than creating", async () => {
    let updatedId: string | undefined;
    const provider = createKomodoNotifyProvider(
        api({
            listAlerters: async () => [{ id: "a9", name: "my-app-notify" }],
            updateAlerter: async (args) => {
                updatedId = args.id;
            },
        }),
    );
    await provider.apply(inputs, undefined, ctx());
    expect(updatedId).toBe("a9");
});

test("malformed inputs are rejected", async () => {
    await expect(createKomodoNotifyProvider(api({})).read({ ...inputs, targets: "nope" }, ctx())).rejects.toThrow(/targets.*array/);
});
