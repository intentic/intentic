import { expect, test } from "vitest";
import type { SshExecutor } from "../core/ssh.js";
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

const sshForward: SshExecutor = {
    connect: async () => ({
        exec: async () => ({ stdout: "", stderr: "", code: 0 }),
        dispose: async () => {},
        forward: async () => ({ port: 9999, close: async () => {} }),
    }),
};

const inputs = {
    address: "203.0.113.10",
    user: "deploy",
    sshKey: "key",
    adminUser: "intentic",
    adminPassword: "pw",
    org: "squad",
};

test("read returns undefined when the org does not exist", async () => {
    expect(await createForgejoOrgProvider(fakeForgejoApi({ findOrg: async () => false }), sshForward).read(inputs, ctx())).toBeUndefined();
});

test("read returns an empty-output observation when the org exists", async () => {
    expect(await createForgejoOrgProvider(fakeForgejoApi({ findOrg: async () => true }), sshForward).read(inputs, ctx())).toEqual({ outputs: {} });
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
        sshForward,
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
        sshForward,
    );
    await provider.apply(inputs, undefined, ctx());
    expect(createCalled).toBe(false);
});

test("diff is always noop", () => {
    expect(createForgejoOrgProvider(fakeForgejoApi({}), sshForward).diff(inputs, { outputs: {} })).toEqual({ action: "noop" });
});
