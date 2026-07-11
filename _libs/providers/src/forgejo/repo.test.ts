import { expect, test } from "vitest";
import { fakeForgejoApi } from "./forgejo-api.fake.js";
import { createRepoProvider } from "./repo.js";

const ctx = (log: (message: string) => void = () => {}) => ({
    env: {},
    log,
    id: "my-app-repo",
    output: () => {
        throw new Error("unused");
    },
});

const inputs = {
    name: "my-app",
    owner: "admin",
    private: true,
    forgejoUrl: "https://git.example.com",
    domain: "git.example.com",
    adminUser: "admin",
    adminPassword: "pw",
};
const derived = { cloneUrl: "https://git.example.com/admin/my-app.git", sshUrl: "git@git.example.com:admin/my-app.git" };

test("read returns undefined when forgejoUrl is not yet resolved (PENDING)", async () => {
    expect(await createRepoProvider(fakeForgejoApi({})).read({ ...inputs, forgejoUrl: 42 }, ctx())).toBeUndefined();
});

test("read returns undefined when the repo does not exist", async () => {
    expect(await createRepoProvider(fakeForgejoApi({ findRepo: async () => undefined })).read(inputs, ctx())).toBeUndefined();
});

test("read returns deterministically re-derived clone/ssh urls when the repo exists", async () => {
    const observed = await createRepoProvider(
        fakeForgejoApi({ findRepo: async () => ({ cloneUrl: "https://other/x.git", sshUrl: "git@other:x.git" }) }),
    ).read(inputs, ctx());
    expect(observed).toEqual({ outputs: derived });
});

test("read returns undefined and logs when forgejo is unreachable", async () => {
    const logs: string[] = [];
    const provider = createRepoProvider(
        fakeForgejoApi({
            findRepo: async () => {
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

test("apply creates the repo when absent and returns re-derived urls", async () => {
    let created: unknown;
    const provider = createRepoProvider(
        fakeForgejoApi({
            findRepo: async () => undefined,
            createRepo: async (args) => {
                created = args;
                return { cloneUrl: "x", sshUrl: "y" };
            },
        }),
    );
    expect(await provider.apply(inputs, undefined, ctx())).toEqual(derived);
    expect(created).toMatchObject({ owner: "admin", name: "my-app", private: true, autoInit: true });
});

test("apply does not create when the repo already exists", async () => {
    let createCalled = false;
    const provider = createRepoProvider(
        fakeForgejoApi({
            findRepo: async () => ({ cloneUrl: "x", sshUrl: "y" }),
            createRepo: async () => {
                createCalled = true;
                return { cloneUrl: "x", sshUrl: "y" };
            },
        }),
    );
    await provider.apply(inputs, undefined, ctx());
    expect(createCalled).toBe(false);
});

test("a team-owned repo is created under the org (ownerIsOrg) and its urls are namespaced under the org", async () => {
    let created: { owner?: string; ownerIsOrg?: boolean } = {};
    const provider = createRepoProvider(
        fakeForgejoApi({
            findRepo: async () => undefined,
            createRepo: async (args) => {
                created = args;
                return { cloneUrl: "x", sshUrl: "y" };
            },
        }),
    );
    const owned = { ...inputs, owner: "squad" };
    expect(await provider.apply(owned, undefined, ctx())).toEqual({
        cloneUrl: "https://git.example.com/squad/my-app.git",
        sshUrl: "git@git.example.com:squad/my-app.git",
    });
    expect(created).toMatchObject({ owner: "squad", ownerIsOrg: true });
});

test("diff is always noop", () => {
    expect(createRepoProvider(fakeForgejoApi({})).diff(inputs, { outputs: derived })).toEqual({ action: "noop" });
});

test("malformed inputs are rejected", async () => {
    await expect(createRepoProvider(fakeForgejoApi({})).read({ ...inputs, adminPassword: 5 }, ctx())).rejects.toThrow(/repo inputs malformed/);
});
