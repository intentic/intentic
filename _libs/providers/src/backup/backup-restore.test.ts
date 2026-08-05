import { expect, test } from "vitest";
import type { SshExecutor, SshResult, SshSession, SshTarget } from "../core/ssh.js";
import { restoreBackup } from "./backup-restore.js";

const target: SshTarget = { address: "203.0.113.10", user: "deploy", privateKey: "key", port: 22 };

const fakeSsh = (): { executor: SshExecutor; commands: string[] } => {
    const commands: string[] = [];
    const session: SshSession = {
        exec: async (command): Promise<SshResult> => {
            commands.push(command);
            return { stdout: "", stderr: "", code: 0 };
        },
        dispose: async () => {},
    };
    return { executor: { connect: async () => session }, commands };
};

const args = (scope: "forgejo" | "komodo" | "all", executor: SshExecutor) => ({
    target,
    image: "restic/restic:0.19.0@sha256:aaaa",
    repo: "s3:s3.example.com/bucket",
    password: "restic-pw",
    credentials: { AWS_ACCESS_KEY_ID: "AKIA" },
    snapshot: "latest",
    scope,
    log: () => {},
    executor,
});

test("restores via restic with the snapshot + repo + password, then drops the scratch volume", async () => {
    const { executor, commands } = fakeSsh();
    await restoreBackup(args("all", executor));
    expect(commands.some((c) => c.includes("docker volume create intentic-restore"))).toBe(true);
    expect(
        commands.some(
            (c) =>
                c.includes("-r 's3:s3.example.com/bucket'") &&
                c.includes("restore 'latest' --target /restore") &&
                c.includes("RESTIC_PASSWORD='restic-pw'"),
        ),
    ).toBe(true);
    expect(commands.some((c) => c.includes("docker volume rm intentic-restore"))).toBe(true);
});

test("scope=forgejo restores only the forgejo volume", async () => {
    const { executor, commands } = fakeSsh();
    await restoreBackup(args("forgejo", executor));
    expect(commands.some((c) => c.includes("intentic-forgejo-data") && c.includes("/restore/volumes/forgejo"))).toBe(true);
    expect(commands.some((c) => c.includes("komodo_postgres-data"))).toBe(false);
    expect(commands.some((c) => c.includes("host-opt-intentic"))).toBe(false);
});

test("scope=komodo restores the komodo volumes and tears the project down first", async () => {
    const { executor, commands } = fakeSsh();
    await restoreBackup(args("komodo", executor));
    expect(commands.some((c) => c.includes("label=com.docker.compose.project=komodo"))).toBe(true);
    expect(commands.some((c) => c.includes("komodo_postgres-data") && c.includes("/restore/volumes/komodo-postgres"))).toBe(true);
    expect(commands.some((c) => c.includes("komodo_keys"))).toBe(true);
    expect(commands.some((c) => c.includes("intentic-forgejo-data"))).toBe(false);
});

test("scope=all also restores the /opt/intentic host state", async () => {
    const { executor, commands } = fakeSsh();
    await restoreBackup(args("all", executor));
    expect(commands.some((c) => c.includes("-v /opt/intentic:/dest") && c.includes("/restore/host-opt-intentic"))).toBe(true);
});

test("never runs restic forget / prune / repo deletion (snapshots are the user's data)", async () => {
    const { executor, commands } = fakeSsh();
    await restoreBackup(args("all", executor));
    expect(commands.some((c) => c.includes("forget") || c.includes("prune") || (c.includes("restic") && c.includes("delete")))).toBe(false);
});

test("throws if the restic restore fails", async () => {
    const failing: SshExecutor = {
        connect: async () => ({
            exec: async (command): Promise<SshResult> => ({ stdout: "", stderr: "boom", code: command.includes("restore 'latest'") ? 1 : 0 }),
            dispose: async () => {},
        }),
    };
    await expect(restoreBackup(args("all", failing))).rejects.toThrow(/restic restore failed/);
});
