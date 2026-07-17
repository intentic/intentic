import { expect, test } from "vitest";
import type { SshExecutor, SshResult, SshSession } from "../core/ssh.js";
import { createValkeyProvider } from "./valkey.js";
import { createValkeyNamespaceProvider } from "./valkey-namespace.js";

const res = (stdout: string, code = 0): SshResult => ({ stdout, stderr: "", code });

const IMAGE = "valkey/valkey:8.1.1-alpine@sha256:aaaa";

// Drives the valkey instance provider: the ping probe (a piped `... | grep -q PONG`) reports readiness via
// its exit code, docker inspect reports the running image, and docker compose up can be made to fail.
const fakeSsh = (opts: { ready?: boolean; upFails?: boolean; image?: string } = {}): { executor: SshExecutor; commands: string[] } => {
    const commands: string[] = [];
    const session: SshSession = {
        exec: async (command) => {
            commands.push(command);
            if (command.includes("ping")) {
                return res("", opts.ready ? 0 : 1);
            }
            if (command.includes("docker ps -q")) {
                return res(opts.ready ? "cid123" : "");
            }
            if (command.includes(".Config.Labels")) {
                return res("");
            }
            if (command.includes("docker inspect")) {
                return res(opts.image ?? IMAGE);
            }
            if (command.includes("docker compose")) {
                return res("up", opts.upFails ? 1 : 0);
            }
            return res("");
        },
        dispose: async () => {},
    };
    return { executor: { connect: async () => session }, commands };
};

const unreachable: SshExecutor = {
    connect: async () => {
        throw new Error("ECONNREFUSED");
    },
};

const ctx = (id = "cache", log: (message: string) => void = () => {}) => ({ env: {}, log, id, output: () => undefined });

const inputs = {
    server: "host",
    address: "203.0.113.10",
    user: "deploy",
    sshKey: "key",
    internalIp: "10.0.0.5",
    publishPort: 40222,
    adminPassword: "adminpw",
    image: IMAGE,
};
const outputs = { internalHost: "10.0.0.5", port: "40222" };

test("instance read returns undefined until the ping probe passes", async () => {
    expect(await createValkeyProvider(unreachable).read(inputs, ctx())).toBeUndefined();
    expect(await createValkeyProvider(fakeSsh({ ready: false }).executor).read(inputs, ctx())).toBeUndefined();
});

test("instance read returns the deterministic internalHost/port + observed image when ready", async () => {
    expect(await createValkeyProvider(fakeSsh({ ready: true }).executor).read(inputs, ctx())).toEqual({ outputs, detail: { image: IMAGE } });
});

test("instance apply writes compose + a chmod-600 valkey.conf carrying requirepass, brings it up, and returns outputs", async () => {
    const ssh = fakeSsh({ ready: true });
    expect(await createValkeyProvider(ssh.executor).apply(inputs, undefined, ctx())).toEqual(outputs);
    expect(
        ssh.commands.some((c) => c.includes("cat > /opt/intentic/valkey/cache/compose.yaml") && c.includes(IMAGE) && c.includes('"40222:6379"')),
    ).toBe(true);
    expect(ssh.commands.some((c) => c.includes("cat > /opt/intentic/valkey/cache/valkey.conf") && c.includes("requirepass adminpw"))).toBe(true);
    expect(ssh.commands.some((c) => c.includes("chmod 600 /opt/intentic/valkey/cache/valkey.conf"))).toBe(true);
});

// --- The per-app binding provider (valkey-namespace) ---

const bindingSsh = (opts: { container?: boolean; userExists?: boolean } = {}): { executor: SshExecutor; commands: string[] } => {
    const commands: string[] = [];
    const session: SshSession = {
        exec: async (command) => {
            commands.push(command);
            if (command.includes("docker ps -q")) {
                return res(opts.container === false ? "" : "cid123");
            }
            if (command.includes("ACL GETUSER")) {
                return res(opts.userExists ? "flags\non" : "");
            }
            return res("");
        },
        dispose: async () => {},
    };
    return { executor: { connect: async () => session }, commands };
};

const bindingInputs = {
    address: "203.0.113.10",
    user: "deploy",
    sshKey: "key",
    instance: "cache",
    instanceHost: "10.0.0.5",
    instancePort: "40222",
    adminPassword: "adminpw",
    username: "my_app",
    password: "secret",
    keyPrefix: "my_app",
};
const bindingUrl = "redis://my_app:secret@10.0.0.5:40222/0";

test("binding read returns undefined when the ACL user is absent", async () => {
    expect(
        await createValkeyNamespaceProvider(bindingSsh({ userExists: false }).executor).read(bindingInputs, ctx("app-uses-cache")),
    ).toBeUndefined();
});

test("binding read returns the connection URL once the ACL user exists", async () => {
    expect(await createValkeyNamespaceProvider(bindingSsh({ userExists: true }).executor).read(bindingInputs, ctx("app-uses-cache"))).toEqual({
        outputs: { url: bindingUrl },
    });
});

test("binding apply runs ACL SETUSER scoped to the app key prefix and returns the URL", async () => {
    const ssh = bindingSsh();
    expect(await createValkeyNamespaceProvider(ssh.executor).apply(bindingInputs, undefined, ctx("app-uses-cache"))).toEqual({ url: bindingUrl });
    expect(ssh.commands.some((c) => c.includes("ACL SETUSER my_app on") && c.includes("~my_app:*") && c.includes("+@all"))).toBe(true);
});

test("binding delete drops the ACL user", async () => {
    const ssh = bindingSsh({ userExists: true });
    await createValkeyNamespaceProvider(ssh.executor).delete!(bindingInputs, ctx("app-uses-cache"));
    expect(ssh.commands.some((c) => c.includes("ACL DELUSER my_app"))).toBe(true);
});
