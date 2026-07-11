import { expect, test } from "vitest";
import { fakeForgejoApi } from "./forgejo-api.fake.js";
import { createForgejoTeamProvider } from "./forgejo-team.js";

const ctx = (log: (message: string) => void = () => {}) => ({
    env: {},
    log,
    id: "host-git-org-squad-team",
    output: () => {
        throw new Error("unused");
    },
});

const inputs = {
    forgejoUrl: "https://git.example.com",
    adminUser: "intentic",
    adminPassword: "pw",
    org: "squad",
    name: "members",
    permission: "write",
    members: ["alice", "bob"],
    repos: [{ owner: "squad", name: "my-app" }],
};

test("read returns undefined when forgejoUrl is PENDING", async () => {
    expect(await createForgejoTeamProvider(fakeForgejoApi({})).read({ ...inputs, forgejoUrl: 42 }, ctx())).toBeUndefined();
});

test("read returns undefined when the team does not exist", async () => {
    expect(await createForgejoTeamProvider(fakeForgejoApi({ findTeam: async () => undefined })).read(inputs, ctx())).toBeUndefined();
});

test("read surfaces the team's current permission as detail", async () => {
    const observed = await createForgejoTeamProvider(fakeForgejoApi({ findTeam: async () => ({ id: 7, permission: "write" }) })).read(inputs, ctx());
    expect(observed).toEqual({ outputs: {}, detail: { permission: "write" } });
});

test("diff is noop when the permission matches, update when it differs", () => {
    const provider = createForgejoTeamProvider(fakeForgejoApi({}));
    expect(provider.diff(inputs, { outputs: {}, detail: { permission: "write" } })).toEqual({ action: "noop" });
    expect(provider.diff(inputs, { outputs: {}, detail: { permission: "read" } })).toMatchObject({ action: "update" });
});

test("apply creates the team when absent, then adds members and attaches repos", async () => {
    const members: string[] = [];
    const repos: string[] = [];
    let createdPermission: string | undefined;
    const provider = createForgejoTeamProvider(
        fakeForgejoApi({
            findTeam: async () => undefined,
            createTeam: async (args) => {
                createdPermission = args.permission;
                return { id: 7, permission: args.permission };
            },
            addTeamMember: async ({ teamId, username }) => {
                members.push(`${teamId}:${username}`);
            },
            addTeamRepo: async ({ teamId, org, name }) => {
                repos.push(`${teamId}:${org}/${name}`);
            },
        }),
    );
    expect(await provider.apply(inputs, undefined, ctx())).toEqual({});
    expect(createdPermission).toBe("write");
    expect(members).toEqual(["7:alice", "7:bob"]);
    expect(repos).toEqual(["7:squad/my-app"]);
});

test("apply reuses an existing team's id without recreating it", async () => {
    let createCalled = false;
    const members: string[] = [];
    const provider = createForgejoTeamProvider(
        fakeForgejoApi({
            findTeam: async () => ({ id: 9, permission: "write" }),
            createTeam: async () => {
                createCalled = true;
                return { id: 0, permission: "write" };
            },
            addTeamMember: async ({ teamId, username }) => {
                members.push(`${teamId}:${username}`);
            },
            addTeamRepo: async () => {},
        }),
    );
    await provider.apply(inputs, undefined, ctx());
    expect(createCalled).toBe(false);
    expect(members).toEqual(["9:alice", "9:bob"]);
});
