import { expect, test } from "vitest";
import type { SshExecutor, SshResult, SshSession } from "../core/ssh.js";
import { createBackupProvider } from "./backup.js";

const res = (stdout: string, code = 0): SshResult => ({ stdout, stderr: "", code });

const IMAGE = "restic/restic:0.19.0@sha256:aaaa";
const SEP = "|";

// Drives the backup provider over SSH: docker ps reports the container, docker inspect reports the
// create-time image + schedule/repo labels, `command -v docker` finds the host CLI, docker run can fail.
const fakeSsh = (
    opts: { running?: boolean; image?: string; schedule?: string; repo?: string; runFails?: boolean } = {},
): { executor: SshExecutor; commands: string[] } => {
    const commands: string[] = [];
    const session: SshSession = {
        exec: async (command) => {
            commands.push(command);
            if (command.includes("docker inspect")) {
                const image = opts.image ?? IMAGE;
                const schedule = opts.schedule ?? "0 3 * * *";
                const repo = opts.repo ?? "s3:s3.example.com/bucket";
                return res(`${image}${SEP}${schedule}${SEP}${repo}`);
            }
            if (command.includes("docker ps")) {
                return res(opts.running ? "intentic-backup" : "");
            }
            if (command.includes("command -v docker")) {
                return res("/usr/local/bin/docker");
            }
            if (command.includes("docker run")) {
                return res("cid", opts.runFails ? 1 : 0);
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
    id: "host-backup",
    output: () => {
        throw new Error("unused");
    },
});

const inputs = {
    server: "host",
    address: "203.0.113.10",
    user: "deploy",
    sshKey: "key",
    repo: "s3:s3.example.com/bucket",
    password: "restic-pw",
    image: IMAGE,
    signoz: false,
    credentials: { AWS_ACCESS_KEY_ID: "AKIA", AWS_SECRET_ACCESS_KEY: "secret" },
    schedule: "0 3 * * *",
    retention: { daily: 7, weekly: 4, monthly: 6 },
};

test("read returns undefined when the host is unreachable over SSH", async () => {
    expect(await createBackupProvider(unreachable).read(inputs, ctx())).toBeUndefined();
});

test("read returns undefined when the backup container is not running", async () => {
    expect(await createBackupProvider(fakeSsh({ running: false }).executor).read(inputs, ctx())).toBeUndefined();
});

test("read returns the observed image + schedule + repo when running", async () => {
    const observed = await createBackupProvider(fakeSsh({ running: true }).executor).read(inputs, ctx());
    expect(observed).toEqual({ outputs: {}, detail: { image: IMAGE, schedule: "0 3 * * *", repo: "s3:s3.example.com/bucket" } });
});

test("diff is noop when image, schedule, and repo all match", () => {
    const observed = { outputs: {}, detail: { image: IMAGE, schedule: "0 3 * * *", repo: "s3:s3.example.com/bucket" } };
    expect(createBackupProvider(fakeSsh().executor).diff(inputs, observed)).toEqual({ action: "noop" });
});

test("diff is update when the schedule drifts", () => {
    const observed = { outputs: {}, detail: { image: IMAGE, schedule: "0 5 * * *", repo: "s3:s3.example.com/bucket" } };
    expect(createBackupProvider(fakeSsh().executor).diff(inputs, observed).action).toBe("update");
});

test("diff is update when the repo drifts", () => {
    const observed = { outputs: {}, detail: { image: IMAGE, schedule: "0 3 * * *", repo: "b2:other-bucket" } };
    expect(createBackupProvider(fakeSsh().executor).diff(inputs, observed).action).toBe("update");
});

test("diff is update when the image drifts", () => {
    const observed = { outputs: {}, detail: { image: "restic/restic:0.18.0@sha256:old", schedule: "0 3 * * *", repo: "s3:s3.example.com/bucket" } };
    expect(createBackupProvider(fakeSsh().executor).diff(inputs, observed).action).toBe("update");
});

test("apply writes a chmod-600 once-guarded restic.env, the script + crontab, and runs the container with the socket + volume mounts", async () => {
    const ssh = fakeSsh();
    expect(await createBackupProvider(ssh.executor).apply(inputs, undefined, ctx())).toEqual({});
    // Secrets land in a write-once, 0600 env file.
    expect(
        ssh.commands.some(
            (c) => c.includes("test -f /opt/intentic/backup/restic.env") && c.includes("RESTIC_PASSWORD=restic-pw") && c.includes("chmod 600"),
        ),
    ).toBe(true);
    expect(ssh.commands.some((c) => c.includes("AWS_SECRET_ACCESS_KEY=secret"))).toBe(true);
    // The script carries the dumps + restic backup + retention prune; the crontab carries the schedule.
    expect(
        ssh.commands.some(
            (c) =>
                c.includes("cat > /opt/intentic/backup/backup.sh") &&
                c.includes("forgejo dump") &&
                c.includes("pg_dump") &&
                c.includes("forget --keep-daily 7"),
        ),
    ).toBe(true);
    expect(ssh.commands.some((c) => c.includes("cat > /opt/intentic/backup/crontab") && c.includes("0 3 * * *"))).toBe(true);
    // The container mounts the docker socket + host docker CLI + the volumes read-only, labelled with schedule/repo.
    expect(
        ssh.commands.some(
            (c) =>
                c.includes("docker run") &&
                c.includes("--name intentic-backup") &&
                c.includes("/var/run/docker.sock:/var/run/docker.sock") &&
                c.includes("-v intentic-forgejo-data:/volumes/forgejo:ro") &&
                c.includes('--label "intentic.schedule=0 3 * * *"') &&
                c.includes("--entrypoint crond"),
        ),
    ).toBe(true);
});

test("apply does not mount signoz volumes unless opted in; mounts them when signoz is true", async () => {
    const off = fakeSsh();
    await createBackupProvider(off.executor).apply(inputs, undefined, ctx());
    expect(off.commands.some((c) => c.includes("signoz_clickhouse-data"))).toBe(false);

    const on = fakeSsh();
    await createBackupProvider(on.executor).apply({ ...inputs, signoz: true }, undefined, ctx());
    expect(on.commands.some((c) => c.includes("docker run") && c.includes("-v signoz_clickhouse-data:/volumes/signoz-clickhouse:ro"))).toBe(true);
});

test("apply throws when the host has no docker CLI", async () => {
    const ssh: SshExecutor = {
        connect: async () => ({
            exec: async (command) => (command.includes("command -v docker") ? res("") : res("")),
            dispose: async () => {},
        }),
    };
    await expect(createBackupProvider(ssh).apply(inputs, undefined, ctx())).rejects.toThrow(/no docker CLI/);
});

test("delete removes the container + state dir but never runs restic forget / deletes the repo", async () => {
    const ssh = fakeSsh({ running: true });
    await createBackupProvider(ssh.executor).delete(inputs, ctx());
    expect(ssh.commands.some((c) => c.includes("docker rm -f intentic-backup"))).toBe(true);
    expect(ssh.commands.some((c) => c.includes("rm -rf /opt/intentic/backup"))).toBe(true);
    expect(ssh.commands.some((c) => c.includes("restic") && (c.includes("forget") || c.includes("unlock") || c.includes("prune")))).toBe(false);
});

test("malformed inputs are rejected", async () => {
    await expect(createBackupProvider(fakeSsh().executor).read({ ...inputs, repo: 5 }, ctx())).rejects.toThrow(/backup inputs malformed/);
});
