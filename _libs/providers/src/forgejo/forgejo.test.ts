import { expect, test } from "vitest";
import type { SshExecutor, SshResult, SshSession } from "../core/ssh.js";
import { createForgejoProvider } from "./forgejo.js";

const res = (stdout: string, code = 0): SshResult => ({ stdout, stderr: "", code });

const IMAGE = "codeberg.org/forgejo/forgejo:15.0.3@sha256:aaaa";

interface FakeOpts {
    readonly running?: boolean;
    readonly healthy?: boolean;
    readonly token?: string;
    readonly gitToken?: string;
    readonly packagesToken?: string;
    readonly adminExists?: boolean;
    readonly runFails?: boolean;
    readonly image?: string;
}

const fakeSsh = (opts: FakeOpts = {}): { executor: SshExecutor; commands: string[] } => {
    const commands: string[] = [];
    const session: SshSession = {
        exec: async (command) => {
            commands.push(command);
            if (command.includes(".Config.Labels")) {
                return res("");
            }
            if (command.includes("docker inspect")) {
                return res(opts.image ?? IMAGE);
            }
            if (command.includes("docker ps")) {
                return res(opts.running ? "intentic-forgejo" : "");
            }
            if (command.includes("wget -q --spider")) {
                return res("", opts.healthy ? 0 : 1);
            }
            if (command.includes("packages-token")) {
                return res(opts.packagesToken ?? "");
            }
            if (command.includes("git-token")) {
                return res(opts.gitToken ?? "");
            }
            if (command.includes("runner-token")) {
                return res(opts.token ?? "");
            }
            if (command.includes("docker run")) {
                return res("id", opts.runFails ? 1 : 0);
            }
            if (command.includes("admin user create")) {
                return opts.adminExists ? { stdout: "", stderr: "user already exists", code: 1 } : res("ok");
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

const ctx = (log: (message: string) => void = () => {}) => ({
    env: {},
    log,
    id: "host-git",
    output: () => {
        throw new Error("unused in forgejo provider");
    },
});

const inputs = {
    server: "host",
    address: "203.0.113.10",
    user: "deploy",
    sshKey: "key-material",
    internalIp: "10.0.0.5",
    domain: "git.example.com",
    adminUser: "admin",
    adminPassword: "pw",
    image: IMAGE,
};

test("read returns undefined when the host is unreachable over SSH", async () => {
    const logs: string[] = [];
    expect(
        await createForgejoProvider(unreachable).read(
            inputs,
            ctx((m) => logs.push(m)),
        ),
    ).toBeUndefined();
    expect(logs.some((m) => m.includes("not reachable"))).toBe(true);
});

test("read returns undefined when the forgejo container is not running", async () => {
    expect(await createForgejoProvider(fakeSsh({ running: false }).executor).read(inputs, ctx())).toBeUndefined();
});

test("read returns undefined when forgejo is not yet healthy", async () => {
    expect(await createForgejoProvider(fakeSsh({ running: true, healthy: false }).executor).read(inputs, ctx())).toBeUndefined();
});

test("read returns undefined when the runner token is not yet persisted", async () => {
    expect(
        await createForgejoProvider(fakeSsh({ running: true, healthy: true, token: "", gitToken: "gtok" }).executor).read(inputs, ctx()),
    ).toBeUndefined();
});

test("read returns undefined when the git token is not yet persisted", async () => {
    expect(
        await createForgejoProvider(fakeSsh({ running: true, healthy: true, token: "tok-123", gitToken: "", packagesToken: "ptok" }).executor).read(
            inputs,
            ctx(),
        ),
    ).toBeUndefined();
});

test("read returns undefined when the packages token is not yet persisted", async () => {
    expect(
        await createForgejoProvider(
            fakeSsh({ running: true, healthy: true, token: "tok-123", gitToken: "gtok-456", packagesToken: "" }).executor,
        ).read(inputs, ctx()),
    ).toBeUndefined();
});

test("read returns the deterministic url/internalUrl + the persisted runner, git, and packages tokens when healthy", async () => {
    const observed = await createForgejoProvider(
        fakeSsh({ running: true, healthy: true, token: "tok-123", gitToken: "gtok-456", packagesToken: "ptok-789" }).executor,
    ).read(inputs, ctx());
    expect(observed).toEqual({
        outputs: {
            url: "https://git.example.com",
            internalUrl: "http://10.0.0.5:3000",
            runnerToken: "tok-123",
            gitToken: "gtok-456",
            packagesToken: "ptok-789",
        },
        detail: { image: IMAGE },
    });
});

test("diff is noop when the running image matches the desired pin", () => {
    expect(createForgejoProvider(fakeSsh().executor).diff(inputs, { outputs: {}, detail: { image: IMAGE } })).toEqual({ action: "noop" });
});

test("diff is update when the running image differs from the desired pin", () => {
    const observed = { outputs: {}, detail: { image: "codeberg.org/forgejo/forgejo:14.0.0@sha256:bbbb" } };
    expect(createForgejoProvider(fakeSsh().executor).diff(inputs, observed).action).toBe("update");
});

test("apply runs forgejo with INSTALL_LOCK + the stamp label, bootstraps admin, mints all tokens, and returns outputs", async () => {
    const ssh = fakeSsh({ healthy: true, token: "tok-123", gitToken: "gtok-456", packagesToken: "ptok-789" });
    const result = await createForgejoProvider(ssh.executor).apply(inputs, undefined, ctx());
    expect(result).toEqual({
        url: "https://git.example.com",
        internalUrl: "http://10.0.0.5:3000",
        runnerToken: "tok-123",
        gitToken: "gtok-456",
        packagesToken: "ptok-789",
    });
    expect(ssh.commands.some((c) => c.includes("docker run") && c.includes("INSTALL_LOCK=true") && c.includes("intentic.id=host-git"))).toBe(true);
    expect(ssh.commands.some((c) => c.includes("admin user create") && c.includes("--password pw"))).toBe(true);
    expect(ssh.commands.some((c) => c.includes("generate-runner-token"))).toBe(true);
    expect(ssh.commands.some((c) => c.includes("generate-access-token") && c.includes("--scopes read:repository"))).toBe(true);
    expect(ssh.commands.some((c) => c.includes("generate-access-token") && c.includes("--scopes write:package,read:package"))).toBe(true);
});

test("apply tolerates the admin user already existing", async () => {
    const ssh = fakeSsh({ healthy: true, token: "tok-123", gitToken: "gtok-456", packagesToken: "ptok-789", adminExists: true });
    await expect(createForgejoProvider(ssh.executor).apply(inputs, undefined, ctx())).resolves.toBeDefined();
});

test("apply throws when docker run exits non-zero", async () => {
    const ssh = fakeSsh({ healthy: true, runFails: true });
    await expect(createForgejoProvider(ssh.executor).apply(inputs, undefined, ctx())).rejects.toThrow(/failed to start forgejo/);
});

test("apply propagates an SSH connection failure", async () => {
    await expect(createForgejoProvider(unreachable).apply(inputs, undefined, ctx())).rejects.toThrow("ECONNREFUSED");
});

test("a guarded update snapshots the data volume before recreating; the happy path issues no restore", async () => {
    const ssh = fakeSsh({ healthy: true, token: "tok-123", gitToken: "gtok-456", packagesToken: "ptok-789" });
    const observed = { outputs: {}, detail: { image: "codeberg.org/forgejo/forgejo:14.0.0@sha256:old" } };
    await createForgejoProvider(ssh.executor).apply(
        { ...inputs, guardRepo: "s3:s3.example.com/bucket", resticImage: "restic/restic:0.19.0@sha256:r" },
        observed,
        ctx(),
    );
    expect(ssh.commands.some((c) => c.includes("backup /v --tag intentic-preupdate-host-git") && c.includes("intentic-forgejo-data"))).toBe(true);
    expect(ssh.commands.some((c) => c.includes("restore latest --tag"))).toBe(false);
});

test("a non-guarded apply issues no restic commands (Phase-1 behavior)", async () => {
    const ssh = fakeSsh({ healthy: true, token: "tok-123", gitToken: "gtok-456", packagesToken: "ptok-789" });
    await createForgejoProvider(ssh.executor).apply(inputs, undefined, ctx());
    expect(ssh.commands.some((c) => c.includes("restic") || c.includes("intentic-preupdate"))).toBe(false);
});

test("malformed inputs are rejected", async () => {
    await expect(createForgejoProvider(fakeSsh().executor).read({ ...inputs, adminPassword: 5 }, ctx())).rejects.toThrow(/forgejo inputs malformed/);
});
