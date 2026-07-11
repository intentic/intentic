import type { DesiredStateGraph, ResourceNode } from "@intentic/graph";
import type { SshExecutor, SshResult, SshSession, SshTarget } from "@intentic/providers";
import { expect, test } from "vitest";
import { detectHostMoves, migrateHosts } from "./migrate.js";

const secret = (key: string) => ({ $secret: { source: "env", key } });
const hostNode = (id: string, address: string): ResourceNode => ({
    id,
    type: "host",
    inputs: { address, user: "deploy", sshKey: secret("HOST_SSH_KEY") },
    dependsOn: [],
});
const backupNode = (address: string): ResourceNode => ({
    id: "host-backup",
    type: "backup",
    inputs: {
        address,
        user: "deploy",
        sshKey: secret("HOST_SSH_KEY"),
        repo: "/repo",
        password: secret("RESTIC_PASSWORD"),
        image: "restic/restic:test",
        signoz: false,
    },
    dependsOn: [],
});
const graphOf = (...nodes: ResourceNode[]): DesiredStateGraph => ({ version: 1, resources: Object.fromEntries(nodes.map((n) => [n.id, n])) });

test("detectHostMoves flags a host whose address changed", () => {
    const moves = detectHostMoves(graphOf(hostNode("host", "10.0.0.1")), graphOf(hostNode("host", "10.0.0.2")));
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ id: "host", oldAddress: "10.0.0.1", newAddress: "10.0.0.2" });
});

test("detectHostMoves ignores an unchanged address, a new id, a removed id, and a creds-only change", () => {
    expect(detectHostMoves(graphOf(hostNode("host", "10.0.0.1")), graphOf(hostNode("host", "10.0.0.1")))).toEqual([]);
    // A brand-new host id is a create, not a move; a removed id is a prune.
    expect(detectHostMoves(graphOf(hostNode("old", "10.0.0.1")), graphOf(hostNode("new", "10.0.0.2")))).toEqual([]);
    // Same address, different SSH key — same machine, new creds, not a migration.
    const reKeyed: ResourceNode = {
        id: "host",
        type: "host",
        inputs: { address: "10.0.0.1", user: "deploy", sshKey: secret("OTHER_KEY") },
        dependsOn: [],
    };
    expect(detectHostMoves(graphOf(hostNode("host", "10.0.0.1")), graphOf(reKeyed))).toEqual([]);
});

// Records every exec by the host it ran on, plus each SFTP transfer, so a test can assert the migration drove
// the right commands on the old vs new machine.
const respond = (command: string): SshResult => {
    if (command.includes("name=^intentic-backup$")) return { stdout: "intentic-backup", stderr: "", code: 0 };
    if (command.includes("label=intentic.id")) return { stdout: "intentic-forgejo\nintentic-backup", stderr: "", code: 0 };
    if (command.includes("project=komodo")) return { stdout: "komodo-core-1", stderr: "", code: 0 };
    return { stdout: "", stderr: "", code: 0 };
};

const fakeExecutor = (unreachable?: string) => {
    const calls: { address: string; command: string }[] = [];
    const transfers: { kind: "download" | "upload"; address: string }[] = [];
    const executor: SshExecutor = {
        connect: async (target: SshTarget): Promise<SshSession> => {
            if (target.address === unreachable) {
                throw new Error("connection refused");
            }
            return {
                exec: async (command) => {
                    calls.push({ address: target.address, command });
                    return respond(command);
                },
                dispose: async () => {},
                download: async () => {
                    transfers.push({ kind: "download", address: target.address });
                },
                upload: async () => {
                    transfers.push({ kind: "upload", address: target.address });
                },
            };
        },
    };
    return { executor, calls, transfers };
};

const env = { HOST_SSH_KEY: "k", RESTIC_PASSWORD: "pw" };

test("migrateHosts snapshots the old host, streams the repo, and restores on the new host", async () => {
    const previous = graphOf(hostNode("host", "10.0.0.1"));
    const next = graphOf(hostNode("host", "10.0.0.2"), backupNode("10.0.0.2"));
    const moves = detectHostMoves(previous, next);
    const { executor, calls, transfers } = fakeExecutor();

    await migrateHosts(moves, { next, ssh: executor, env, tmpDir: "/tmp", log: () => {} });

    const onOld = calls.filter((c) => c.address === "10.0.0.1").map((c) => c.command);
    const onNew = calls.filter((c) => c.address === "10.0.0.2").map((c) => c.command);
    // Old host: writers stopped, fresh snapshot taken, repo packed.
    expect(onOld.some((c) => c.includes("docker stop intentic-forgejo-runner"))).toBe(true);
    expect(onOld.some((c) => c.includes("docker exec intentic-backup /bin/sh /opt/intentic/backup/backup.sh"))).toBe(true);
    expect(onOld.some((c) => c.includes("tar czf /out/migrate-repo.tgz"))).toBe(true);
    // Streamed old → new through the CLI.
    expect(transfers).toContainEqual({ kind: "download", address: "10.0.0.1" });
    expect(transfers).toContainEqual({ kind: "upload", address: "10.0.0.2" });
    // New host: repo unpacked, then restored.
    expect(onNew.some((c) => c.includes("tar xzf /in/migrate-repo.tgz"))).toBe(true);
    expect(onNew.some((c) => c.includes("docker volume create intentic-restore"))).toBe(true);
    expect(onNew.some((c) => c.includes("restore 'latest' --target /restore"))).toBe(true);
});

test("migrateHosts refuses when the old machine is unreachable and the repo lives on it", async () => {
    const moves = detectHostMoves(graphOf(hostNode("host", "10.0.0.1")), graphOf(hostNode("host", "10.0.0.2"), backupNode("10.0.0.2")));
    const { executor } = fakeExecutor("10.0.0.1");
    await expect(
        migrateHosts(moves, {
            next: graphOf(hostNode("host", "10.0.0.2"), backupNode("10.0.0.2")),
            ssh: executor,
            env,
            tmpDir: "/tmp",
            log: () => {},
        }),
    ).rejects.toThrow(/unreachable/);
});
