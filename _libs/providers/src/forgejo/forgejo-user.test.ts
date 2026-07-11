import { expect, test } from "vitest";
import { fakeForgejoApi } from "./forgejo-api.fake.js";
import { createForgejoUserProvider } from "./forgejo-user.js";

const ctx = (log: (message: string) => void = () => {}) => ({
    env: {},
    log,
    id: "host-git-user-alice",
    output: () => {
        throw new Error("unused");
    },
});

const inputs = {
    forgejoUrl: "https://git.example.com",
    adminUser: "intentic",
    adminPassword: "pw",
    username: "alice",
    email: "alice@example.com",
    accountPassword: "generated",
};

test("read returns undefined when forgejoUrl is PENDING", async () => {
    expect(await createForgejoUserProvider(fakeForgejoApi({})).read({ ...inputs, forgejoUrl: 42 }, ctx())).toBeUndefined();
});

test("read returns undefined when the user does not exist", async () => {
    expect(await createForgejoUserProvider(fakeForgejoApi({ findUser: async () => false })).read(inputs, ctx())).toBeUndefined();
});

test("read returns an empty-output observation when the user exists", async () => {
    expect(await createForgejoUserProvider(fakeForgejoApi({ findUser: async () => true })).read(inputs, ctx())).toEqual({ outputs: {} });
});

test("read returns undefined and logs when forgejo is unreachable", async () => {
    const logs: string[] = [];
    const provider = createForgejoUserProvider(
        fakeForgejoApi({
            findUser: async () => {
                throw new Error("ECONNREFUSED");
            },
        }),
    );
    expect(
        await provider.read(
            inputs,
            ctx((m) => logs.push(m)),
        ),
    ).toBeUndefined();
    expect(logs.some((m) => m.includes("not reachable"))).toBe(true);
});

test("apply creates the account when absent, with must-change-password disabled", async () => {
    let created: unknown;
    const provider = createForgejoUserProvider(
        fakeForgejoApi({
            findUser: async () => false,
            createUser: async (args) => {
                created = args;
            },
        }),
    );
    expect(await provider.apply(inputs, undefined, ctx())).toEqual({});
    expect(created).toMatchObject({ username: "alice", email: "alice@example.com", accountPassword: "generated" });
});

test("apply does not create when the account already exists", async () => {
    let createCalled = false;
    const provider = createForgejoUserProvider(
        fakeForgejoApi({
            findUser: async () => true,
            createUser: async () => {
                createCalled = true;
            },
        }),
    );
    await provider.apply(inputs, undefined, ctx());
    expect(createCalled).toBe(false);
});

test("diff is always noop", () => {
    expect(createForgejoUserProvider(fakeForgejoApi({})).diff(inputs, { outputs: {} })).toEqual({ action: "noop" });
});

test("malformed inputs are rejected", async () => {
    await expect(createForgejoUserProvider(fakeForgejoApi({})).read({ ...inputs, username: 5 }, ctx())).rejects.toThrow(
        /forgejo-user inputs malformed/,
    );
});
