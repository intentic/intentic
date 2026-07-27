import { expect, test } from "vitest";
import type { SshExecutor } from "../core/ssh.js";
import { fakeForgejoApi } from "./forgejo-api.fake.js";
import type { ForgejoHook } from "./forgejo-api.js";
import { createForgejoNotifyProvider } from "./forgejo-notify.js";

const ctx = () => ({
    env: {},
    log: () => {},
    id: "my-app-repo-notify",
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
    adminUser: "admin",
    adminPassword: "pw",
    owner: "admin",
    repoName: "my-app",
    webhook: "https://discord.test/wh",
    events: ["build"],
};
const discordHook = (over: Partial<ForgejoHook> = {}): ForgejoHook => ({
    id: 1,
    type: "discord",
    config: { url: "https://discord.test/wh" },
    events: ["push"],
    active: true,
    ...over,
});

test("read returns undefined when no discord hook matches the webhook url", async () => {
    expect(await createForgejoNotifyProvider(fakeForgejoApi({ listHooks: async () => [] }), sshForward).read(inputs, ctx())).toBeUndefined();
});

test("read returns the matched discord hook detail", async () => {
    const observed = await createForgejoNotifyProvider(fakeForgejoApi({ listHooks: async () => [discordHook()] }), sshForward).read(inputs, ctx());
    expect(observed).toEqual({ outputs: {}, detail: { events: ["push"], active: true } });
});

test("diff is noop when active and events match", () => {
    expect(
        createForgejoNotifyProvider(fakeForgejoApi({}), sshForward).diff(inputs, { outputs: {}, detail: { events: ["push"], active: true } }),
    ).toEqual({
        action: "noop",
    });
});

test("diff is update when the hook is disabled", () => {
    expect(
        createForgejoNotifyProvider(fakeForgejoApi({}), sshForward).diff(inputs, { outputs: {}, detail: { events: ["push"], active: false } }).action,
    ).toBe("update");
});

test("diff is update when events differ", () => {
    expect(
        createForgejoNotifyProvider(fakeForgejoApi({}), sshForward).diff(inputs, { outputs: {}, detail: { events: ["pull_request"], active: true } })
            .action,
    ).toBe("update");
});

test("apply creates a discord webhook when none matches", async () => {
    let created: unknown;
    const provider = createForgejoNotifyProvider(
        fakeForgejoApi({
            listHooks: async () => [],
            createHook: async (args) => {
                created = args;
            },
        }),
        sshForward,
    );
    expect(await provider.apply(inputs, undefined, ctx())).toEqual({});
    expect(created).toMatchObject({ type: "discord", config: { url: "https://discord.test/wh", content_type: "json" }, events: ["push"] });
});

test("apply updates the existing matching hook rather than creating", async () => {
    let updatedId: number | undefined;
    const provider = createForgejoNotifyProvider(
        fakeForgejoApi({
            listHooks: async () => [discordHook({ id: 7 })],
            updateHook: async (args) => {
                updatedId = args.id;
            },
        }),
        sshForward,
    );
    await provider.apply(inputs, undefined, ctx());
    expect(updatedId).toBe(7);
});

test("read returns undefined when webhook is PENDING", async () => {
    expect(await createForgejoNotifyProvider(fakeForgejoApi({}), sshForward).read({ ...inputs, webhook: Symbol("PENDING") }, ctx())).toBeUndefined();
});
