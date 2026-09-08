import { rm } from "node:fs/promises";
import { join } from "node:path";
import { createStore, resolveInputs } from "@intentic/engine";
import type { DesiredStateGraph, ResourceNode } from "@intentic/graph";
import {
    hostTarget,
    isLocalRepo,
    managedContainers,
    quiesceHost,
    type RestoreScope,
    restoreBackup,
    type SshExecutor,
    type SshSession,
    snapshotNow,
    streamRepoVolume,
} from "@intentic/providers";

// A host whose id is unchanged but whose `address` changed. `address` is a plain literal (not a secret), so detecting a
// move needs no secret resolution.
export interface HostMove {
    readonly id: string;
    readonly oldNode: ResourceNode;
    readonly newNode: ResourceNode;
    readonly oldAddress: string;
    readonly newAddress: string;
}

// Detects hosts with the same id but a different `address` between the last-applied graph and the one being applied. A
// new id is a create; a removed id is a prune; neither counts as a move.
export const detectHostMoves = (previous: DesiredStateGraph, next: DesiredStateGraph): HostMove[] => {
    const moves: HostMove[] = [];
    for (const [id, newNode] of Object.entries(next.resources)) {
        if (newNode.type !== "host") {
            continue;
        }
        const oldNode = previous.resources[id];
        if (oldNode === undefined || oldNode.type !== "host") {
            continue;
        }
        const oldAddress = oldNode.inputs["address"];
        const newAddress = newNode.inputs["address"];
        if (typeof oldAddress !== "string" || typeof newAddress !== "string") {
            throw new Error(`host "${id}" address is not a literal string; a host migration needs a literal address on both sides`);
        }
        if (oldAddress === newAddress) {
            continue;
        }
        moves.push({ id, oldNode, newNode, oldAddress, newAddress });
    }
    return moves;
};

interface MigrateArgs {
    readonly next: DesiredStateGraph;
    readonly ssh: SshExecutor;
    readonly env: Record<string, string | undefined>;
    readonly tmpDir: string;
    readonly log: (message: string) => void;
}

// Finds the control-plane backup node for a moved host's new address (one per CP host); its inputs carry the
// repo/password/image restore reads back. Undefined if the host runs no control plane.
const backupFor = (
    move: HostMove,
    args: MigrateArgs,
): { repo: string; password: string; image: string; credentials: Record<string, string> } | undefined => {
    const node = Object.values(args.next.resources).find((n) => n.type === "backup" && n.inputs["address"] === move.newAddress);
    if (node === undefined) {
        return undefined;
    }
    const resolved = resolveInputs(node.inputs, createStore(), args.env, { lenient: false });
    const { repo, password, image } = resolved;
    if (typeof repo !== "string" || typeof password !== "string" || typeof image !== "string") {
        throw new Error(`backup for host "${move.id}" is missing its repo/password/image inputs`);
    }
    const credentials: Record<string, string> = {};
    const credsRaw = resolved["credentials"];
    if (typeof credsRaw === "object" && credsRaw !== null) {
        for (const [key, value] of Object.entries(credsRaw)) {
            if (typeof value === "string") {
                credentials[key] = value;
            }
        }
    }
    return { repo, password, image, credentials };
};

// Snapshots the old host, streams its on-host restic repo to the new host (skipped when remote), and restores there;
// reconcile brings services up after. The old host is left quiesced with data intact for verification.
const migrateHost = async (move: HostMove, args: MigrateArgs): Promise<void> => {
    const backup = backupFor(move, args);
    if (backup === undefined) {
        args.log(
            `host "${move.id}" moved ${move.oldAddress} → ${move.newAddress} but runs no control plane; its data is not migrated (apps are recreated on the new host)`,
        );
        return;
    }
    const newTarget = hostTarget(resolveInputs(move.newNode.inputs, createStore(), args.env, { lenient: false }));
    const oldTarget = hostTarget(resolveInputs(move.oldNode.inputs, createStore(), args.env, { lenient: false }));
    const local = isLocalRepo(backup.repo);

    let oldSession: SshSession | undefined;
    try {
        oldSession = await args.ssh.connect(oldTarget);
    } catch (error) {
        if (local) {
            throw new Error(
                `host "${move.id}" moved to ${move.newAddress}, but its old machine ${move.oldAddress} is unreachable and the restic repo lives on it, bring the old host back to migrate its data: ${String(error)}`,
                { cause: error },
            );
        }
        args.log(
            `old host ${move.oldAddress} unreachable; restoring "${move.id}" on ${move.newAddress} from the latest snapshot in ${backup.repo} (data is as of the last scheduled backup)`,
        );
    }

    if (oldSession !== undefined) {
        try {
            const managed = await managedContainers(oldSession);
            if (managed.length === 0) {
                args.log(`old host ${move.oldAddress} has no intentic-managed containers; nothing to migrate for "${move.id}"`);
                return;
            }
            args.log(`migrating host "${move.id}" ${move.oldAddress} → ${move.newAddress} (${managed.length} managed container(s))`);
            await quiesceHost(oldSession);
            await snapshotNow(oldSession, args.log);
            await oldSession.exec("docker stop intentic-backup 2>/dev/null || true");
            if (local) {
                const tarPath = join(args.tmpDir, `intentic-migrate-${move.id}.tgz`);
                const newSession = await args.ssh.connect(newTarget);
                try {
                    await streamRepoVolume(oldSession, newSession, backup.image, tarPath, args.log);
                } finally {
                    await newSession.dispose();
                    await rm(tarPath, { force: true });
                }
            }
        } finally {
            await oldSession.dispose();
        }
    }

    await restoreBackup({
        target: newTarget,
        image: backup.image,
        repo: backup.repo,
        password: backup.password,
        credentials: backup.credentials,
        snapshot: "latest",
        scope: "all" satisfies RestoreScope,
        log: args.log,
        executor: args.ssh,
    });
    args.log(`restored "${move.id}" data onto ${move.newAddress}; reconcile will bring its services up next`);
};

// Migrates every moved host before reconcile, so data is in place when services are (re)created. No-op if nothing
// moved.
export const migrateHosts = async (moves: readonly HostMove[], args: MigrateArgs): Promise<void> => {
    for (const move of moves) {
        await migrateHost(move, args);
    }
};
