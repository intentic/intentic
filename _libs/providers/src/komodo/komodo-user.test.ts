import { expect, test } from "vitest";
import type { SshExecutor } from "../core/ssh.js";
import { unstubbed } from "../testing.js";
import type { KomodoApi } from "./komodo-api.js";
import { createKomodoUserProvider } from "./komodo-user.js";

const sshForward: SshExecutor = {
    connect: async () => ({
        exec: async () => ({ stdout: "", stderr: "", code: 0 }),
        dispose: async () => {},
        forward: async () => ({ port: 9999, close: async () => {} }),
    }),
};

// Only the calls a suite asserts on are stubbed; anything else the provider reaches names itself.
const api = (overrides: Partial<KomodoApi>): KomodoApi =>
    unstubbed("komodo", {
        login: async () => "jwt",
        ...overrides,
    });

const ctx = (log: (message: string) => void = () => {}) => ({
    env: {},
    log,
    id: "host-deploy-user-alice",
    output: () => {
        throw new Error("unused");
    },
});

const inputs = {
    address: "203.0.113.10",
    user: "deploy",
    sshKey: "key",
    adminUser: "intentic",
    adminPassword: "pw",
    username: "alice",
    password: "generated",
    grants: [{ deployment: "my-app.production", level: "Execute" as const }],
};

test("read returns undefined when the user does not exist", async () => {
    expect(await createKomodoUserProvider(api({ listUsers: async () => [] }), sshForward).read(inputs, ctx())).toBeUndefined();
});

test("read surfaces enabled state as detail when the user exists", async () => {
    const observed = await createKomodoUserProvider(
        api({ listUsers: async () => [{ id: "u1", username: "alice", enabled: true }] }),
        sshForward,
    ).read(inputs, ctx());
    expect(observed).toEqual({ outputs: {}, detail: { enabled: true } });
});

test("read returns undefined and logs when komodo is unreachable", async () => {
    const logs: string[] = [];
    const provider = createKomodoUserProvider(
        api({
            login: async () => {
                throw new Error("ECONNREFUSED");
            },
        }),
        sshForward,
    );
    expect(
        await provider.read(
            inputs,
            ctx((m) => logs.push(m)),
        ),
    ).toBeUndefined();
    expect(logs.some((m) => m.includes("not reachable"))).toBe(true);
});

test("diff is update when the user is not enabled, noop when enabled", () => {
    const provider = createKomodoUserProvider(api({}), sshForward);
    expect(provider.diff(inputs, { outputs: {}, detail: { enabled: false } })).toMatchObject({ action: "update" });
    expect(provider.diff(inputs, { outputs: {}, detail: { enabled: true } })).toEqual({ action: "noop" });
});

test("apply creates the user when absent, enables it, then grants each deployment", async () => {
    const events: string[] = [];
    let listed = 0;
    const provider = createKomodoUserProvider(
        api({
            listUsers: async () => {
                listed += 1;
                // Absent on the first lookup, present (with its id) after creation.
                return listed === 1 ? [] : [{ id: "u1", username: "alice", enabled: false }];
            },
            createUser: async ({ username }) => {
                events.push(`create:${username}`);
            },
            enableUser: async ({ userId }) => {
                events.push(`enable:${userId}`);
            },
            setPermissionOnTarget: async ({ userId, deployment, level }) => {
                events.push(`grant:${userId}:${deployment}:${level}`);
            },
        }),
        sshForward,
    );
    expect(await provider.apply(inputs, undefined, ctx())).toEqual({});
    expect(events).toEqual(["create:alice", "enable:u1", "grant:u1:my-app.production:Execute"]);
});

test("apply does not recreate an existing user, but still enables and grants", async () => {
    const events: string[] = [];
    const provider = createKomodoUserProvider(
        api({
            listUsers: async () => [{ id: "u1", username: "alice", enabled: false }],
            createUser: async () => {
                events.push("create");
            },
            enableUser: async ({ userId }) => {
                events.push(`enable:${userId}`);
            },
            setPermissionOnTarget: async ({ deployment }) => {
                events.push(`grant:${deployment}`);
            },
        }),
        sshForward,
    );
    await provider.apply(inputs, undefined, ctx());
    expect(events).toEqual(["enable:u1", "grant:my-app.production"]);
});

test("malformed inputs are rejected", async () => {
    await expect(createKomodoUserProvider(api({}), sshForward).read({ ...inputs, username: 5 }, ctx())).rejects.toThrow(
        /komodo-user inputs malformed/,
    );
});
