import { expect, test } from "vitest";
import { createCiProvider } from "./ci.js";
import { fakeForgejoApi } from "./forgejo-api.fake.js";

const ctx = (log: (message: string) => void = () => {}) => ({
    env: {},
    log,
    id: "my-app.production-ci",
    output: () => {
        throw new Error("unused");
    },
});

const inputs = {
    forgejoUrl: "https://git.example.com",
    adminUser: "intentic",
    adminPassword: "fpw",
    komodoPassword: "kpw",
    owner: "intentic",
    repoName: "my-app",
    branch: "main",
    registry: "127.0.0.1:3000",
    tag: "production",
    packagesToken: "ptok",
    komodoUrl: "http://10.0.0.5:9120",
    deployment: "my-app.production",
};

const WORKFLOW_PATH = ".forgejo/workflows/build-production.yaml";

test("read returns undefined when forgejoUrl is PENDING", async () => {
    expect(await createCiProvider(fakeForgejoApi({})).read({ ...inputs, forgejoUrl: 42 }, ctx())).toBeUndefined();
});

test("read returns undefined when komodoUrl is PENDING", async () => {
    expect(await createCiProvider(fakeForgejoApi({})).read({ ...inputs, komodoUrl: 42 }, ctx())).toBeUndefined();
});

test("read returns undefined when the workflow file is absent (not wired yet)", async () => {
    expect(await createCiProvider(fakeForgejoApi({ readFile: async () => undefined })).read(inputs, ctx())).toBeUndefined();
});

test("read returns the workflow contents when present", async () => {
    const observed = await createCiProvider(fakeForgejoApi({ readFile: async () => "on: push" })).read(inputs, ctx());
    expect(observed).toEqual({ outputs: {}, detail: { workflow: "on: push" } });
});

test("read returns undefined and logs when forgejo is unreachable", async () => {
    const logs: string[] = [];
    const provider = createCiProvider(
        fakeForgejoApi({
            readFile: async () => {
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

test("apply sets both repo secrets, seeds a Dockerfile when absent, and commits the per-env workflow", async () => {
    const secrets: Record<string, string> = {};
    const commits: Record<string, string> = {};
    const provider = createCiProvider(
        fakeForgejoApi({
            setRepoSecret: async ({ secretName, data }) => {
                secrets[secretName] = data;
            },
            readFile: async () => undefined,
            commitFile: async ({ path, content }) => {
                commits[path] = content;
            },
        }),
    );
    await provider.apply(inputs, undefined, ctx());
    // REGISTRY_TOKEN is the packages token (registry push); KOMODO_PASSWORD is the Komodo admin pw (notify login).
    expect(secrets["REGISTRY_TOKEN"]).toBe("ptok");
    expect(secrets["KOMODO_PASSWORD"]).toBe("kpw");
    expect(commits["Dockerfile"]).toContain("FROM busybox");
    expect(commits[WORKFLOW_PATH]).toContain("127.0.0.1:3000/intentic/my-app:production");
    expect(commits[WORKFLOW_PATH]).toContain('"deployment":"my-app.production"');
});

test("apply does not clobber an existing Dockerfile", async () => {
    const commits: Record<string, string> = {};
    const provider = createCiProvider(
        fakeForgejoApi({
            setRepoSecret: async () => {},
            readFile: async ({ path }) => (path === "Dockerfile" ? "FROM node:20" : undefined),
            commitFile: async ({ path, content }) => {
                commits[path] = content;
            },
        }),
    );
    await provider.apply(inputs, undefined, ctx());
    expect(commits["Dockerfile"]).toBeUndefined();
    expect(commits[WORKFLOW_PATH]).toBeDefined();
});

test("diff is noop when the committed workflow matches desired, update when it differs", async () => {
    let committed = "";
    const provider = createCiProvider(
        fakeForgejoApi({
            setRepoSecret: async () => {},
            readFile: async () => undefined,
            commitFile: async ({ path, content }) => {
                if (path === WORKFLOW_PATH) {
                    committed = content;
                }
            },
        }),
    );
    await provider.apply(inputs, undefined, ctx());
    expect(provider.diff(inputs, { outputs: {}, detail: { workflow: committed } })).toEqual({ action: "noop" });
    expect(provider.diff(inputs, { outputs: {}, detail: { workflow: "stale" } }).action).toBe("update");
});

test("diff is update when no workflow was observed", () => {
    expect(createCiProvider(fakeForgejoApi({})).diff(inputs, { outputs: {} }).action).toBe("update");
});

test("malformed inputs are rejected", async () => {
    await expect(createCiProvider(fakeForgejoApi({})).read({ ...inputs, packagesToken: 5 }, ctx())).rejects.toThrow(/ci inputs malformed/);
});
