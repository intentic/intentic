import { expect, test } from "vitest";
import { fakeForgejoApi } from "./forgejo-api.fake.js";
import { createForgejoOrgProvider } from "./forgejo-org.js";

const ctx = (log: (message: string) => void = () => {}) => ({
    env: {},
    log,
    id: "host-git-org-squad",
    output: () => {
        throw new Error("unused");
    },
});

const inputs = {
    forgejoUrl: "https://git.example.com",
    adminUser: "intentic",
    adminPassword: "pw",
    org: "squad",
};

test("read returns undefined when forgejoUrl is PENDING", async () => {
    expect(await createForgejoOrgProvider(fakeForgejoApi({})).read({ ...inputs, forgejoUrl: 42 }, ctx())).toBeUndefined();
});

test("read returns undefined when the org does not exist", async () => {
    expect(await createForgejoOrgProvider(fakeForgejoApi({ findOrg: async () => false })).read(inputs, ctx())).toBeUndefined();
});

test("read returns an empty-output observation when the org exists", async () => {
    expect(await createForgejoOrgProvider(fakeForgejoApi({ findOrg: async () => true })).read(inputs, ctx())).toEqual({ outputs: {} });
});

test("apply creates the org under the admin when absent", async () => {
    let created: unknown;
    const provider = createForgejoOrgProvider(
        fakeForgejoApi({
            findOrg: async () => false,
            createOrg: async (args) => {
                created = args;
            },
        }),
    );
    expect(await provider.apply(inputs, undefined, ctx())).toEqual({});
    expect(created).toMatchObject({ user: "intentic", org: "squad" });
});

test("apply does not create when the org already exists", async () => {
    let createCalled = false;
    const provider = createForgejoOrgProvider(
        fakeForgejoApi({
            findOrg: async () => true,
            createOrg: async () => {
                createCalled = true;
            },
        }),
    );
    await provider.apply(inputs, undefined, ctx());
    expect(createCalled).toBe(false);
});

test("diff is always noop", () => {
    expect(createForgejoOrgProvider(fakeForgejoApi({})).diff(inputs, { outputs: {} })).toEqual({ action: "noop" });
});
