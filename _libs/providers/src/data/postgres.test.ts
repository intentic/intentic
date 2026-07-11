import { expect, test } from "vitest";
import type { SshExecutor, SshResult, SshSession } from "../core/ssh.js";
import { createPostgresProvider } from "./postgres.js";
import { createPostgresDatabaseProvider } from "./postgres-database.js";

const res = (stdout: string, code = 0): SshResult => ({ stdout, stderr: "", code });

const IMAGE = "postgres:17.6-alpine@sha256:aaaa";

// Drives the postgres instance provider over SSH: the pg_isready probe reports readiness, docker inspect
// reports the running image, and docker compose up can be made to fail.
const fakeSsh = (opts: { ready?: boolean; upFails?: boolean; image?: string } = {}): { executor: SshExecutor; commands: string[] } => {
    const commands: string[] = [];
    const session: SshSession = {
        exec: async (command) => {
            commands.push(command);
            if (command.includes("pg_isready")) {
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

const ctx = (id = "db", log: (message: string) => void = () => {}) => ({ env: {}, log, id, output: () => undefined });

const inputs = {
    server: "host",
    address: "203.0.113.10",
    user: "deploy",
    sshKey: "key",
    internalIp: "10.0.0.5",
    publishPort: 40123,
    adminPassword: "pw",
    image: IMAGE,
};
const outputs = { internalHost: "10.0.0.5", port: "40123" };

test("instance read returns undefined when the host is unreachable", async () => {
    expect(await createPostgresProvider(unreachable).read(inputs, ctx())).toBeUndefined();
});

test("instance read returns undefined until pg_isready passes", async () => {
    expect(await createPostgresProvider(fakeSsh({ ready: false }).executor).read(inputs, ctx())).toBeUndefined();
});

test("instance read returns the deterministic internalHost/port + observed image when ready", async () => {
    expect(await createPostgresProvider(fakeSsh({ ready: true }).executor).read(inputs, ctx())).toEqual({ outputs, detail: { image: IMAGE } });
});

test("instance diff is noop on the desired image and update on drift", () => {
    const provider = createPostgresProvider(fakeSsh().executor);
    expect(provider.diff(inputs, { outputs: {}, detail: { image: IMAGE } })).toEqual({ action: "noop" });
    expect(provider.diff(inputs, { outputs: {}, detail: { image: "postgres:16@sha256:bbbb" } }).action).toBe("update");
});

test("instance apply writes compose with the pinned image + the published port mapping, brings it up, and returns outputs", async () => {
    const ssh = fakeSsh({ ready: true });
    const result = await createPostgresProvider(ssh.executor).apply(inputs, undefined, ctx());
    expect(result).toEqual(outputs);
    expect(
        ssh.commands.some((c) => c.includes("cat > /opt/intentic/postgres/db/compose.yaml") && c.includes(IMAGE) && c.includes('"40123:5432"')),
    ).toBe(true);
    // The superuser password is written write-once into the .env (test -f guard), not inlined into compose.
    expect(ssh.commands.some((c) => c.includes("test -f /opt/intentic/postgres/db/.env") && c.includes("POSTGRES_PASSWORD"))).toBe(true);
    expect(ssh.commands.some((c) => c.includes("docker compose") && c.includes("up -d"))).toBe(true);
});

test("instance apply throws when docker compose up exits non-zero", async () => {
    await expect(createPostgresProvider(fakeSsh({ upFails: true }).executor).apply(inputs, undefined, ctx())).rejects.toThrow(
        /failed to bring up postgres/,
    );
});

// --- The per-app binding provider (postgres-database) ---

// Drives the binding provider: docker ps locates the instance container; psql SELECTs report whether the
// role/database already exist (keyed off the SQL text), and writes succeed.
const bindingSsh = (opts: { container?: boolean; roleExists?: boolean; dbExists?: boolean } = {}): { executor: SshExecutor; commands: string[] } => {
    const commands: string[] = [];
    const session: SshSession = {
        exec: async (command) => {
            commands.push(command);
            if (command.includes("docker ps -q")) {
                return res(opts.container === false ? "" : "cid123");
            }
            if (command.includes("pg_roles")) {
                return res(opts.roleExists ? "1" : "");
            }
            if (command.includes("pg_database")) {
                return res(opts.dbExists ? "1" : "");
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
    instance: "db",
    instanceHost: "10.0.0.5",
    instancePort: "40123",
    database: "my_app",
    role: "my_app",
    password: "secret",
};
const bindingUrl = "postgres://my_app:secret@10.0.0.5:40123/my_app";

test("binding read returns undefined when the instance container is absent", async () => {
    expect(await createPostgresDatabaseProvider(bindingSsh({ container: false }).executor).read(bindingInputs, ctx("app-uses-db"))).toBeUndefined();
});

test("binding read returns the connection URL once the database exists", async () => {
    expect(await createPostgresDatabaseProvider(bindingSsh({ dbExists: true }).executor).read(bindingInputs, ctx("app-uses-db"))).toEqual({
        outputs: { url: bindingUrl },
    });
});

test("binding apply creates the role + database when absent and returns the URL", async () => {
    const ssh = bindingSsh({ roleExists: false, dbExists: false });
    const result = await createPostgresDatabaseProvider(ssh.executor).apply(bindingInputs, undefined, ctx("app-uses-db"));
    expect(result).toEqual({ url: bindingUrl });
    expect(ssh.commands.some((c) => c.includes("CREATE ROLE") && c.includes("my_app") && c.includes("secret"))).toBe(true);
    expect(ssh.commands.some((c) => c.includes("CREATE DATABASE") && c.includes("my_app") && c.includes("OWNER"))).toBe(true);
});

test("binding apply only alters the role password (no CREATE) when the role + database already exist", async () => {
    const ssh = bindingSsh({ roleExists: true, dbExists: true });
    await createPostgresDatabaseProvider(ssh.executor).apply(bindingInputs, undefined, ctx("app-uses-db"));
    expect(ssh.commands.some((c) => c.includes("ALTER ROLE") && c.includes("my_app"))).toBe(true);
    expect(ssh.commands.some((c) => c.includes("CREATE ROLE"))).toBe(false);
    expect(ssh.commands.some((c) => c.includes("CREATE DATABASE"))).toBe(false);
});

test("binding apply throws when the instance is not running", async () => {
    await expect(
        createPostgresDatabaseProvider(bindingSsh({ container: false }).executor).apply(bindingInputs, undefined, ctx("app-uses-db")),
    ).rejects.toThrow(/instance "db" is not running/);
});

test("binding delete drops the database and role", async () => {
    const ssh = bindingSsh({ dbExists: true });
    await createPostgresDatabaseProvider(ssh.executor).delete!(bindingInputs, ctx("app-uses-db"));
    expect(ssh.commands.some((c) => c.includes("DROP DATABASE IF EXISTS"))).toBe(true);
    expect(ssh.commands.some((c) => c.includes("DROP ROLE IF EXISTS"))).toBe(true);
});
