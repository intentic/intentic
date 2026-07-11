import type { SshExecutor, SshSession, SshTarget } from "../core/ssh.js";
import { sshExecutor } from "../core/ssh.js";
import { isLocalRepo, REPO_VOLUME } from "./backup.js";

// Which part of the control plane to restore. Forgejo and Komodo recover independently; `all` also restores
// the host-side /opt/intentic state (tokens + secrets) so the recovered databases and their credentials stay
// consistent.
export type RestoreScope = "forgejo" | "komodo" | "all";

export interface RestoreArgs {
    readonly target: SshTarget;
    readonly image: string;
    readonly repo: string;
    readonly password: string;
    readonly credentials?: Record<string, string>;
    readonly snapshot: string;
    readonly scope: RestoreScope;
    readonly log: (message: string) => void;
    readonly executor?: SshExecutor;
}

// A named host volume restic restores the snapshot into, then the per-service restores copy out of.
const RESTORE_VOLUME = "intentic-restore";

// The restic image's entrypoint is `restic`; reuse the same pinned image with `--entrypoint sh` for the
// plain file-copy steps so a restore needs no extra image on the host.
const resticPrefix = (args: RestoreArgs): string => {
    const creds = Object.entries(args.credentials ?? {})
        .map(([key, value]) => `-e ${key}='${value}'`)
        .join(" ");
    // A local (on-host) repo lives in REPO_VOLUME — mount it at the repo path so restic can read it. The
    // migration streams that volume onto this host first, so the repo is present before restore runs.
    const repoMount = isLocalRepo(args.repo) ? `-v ${REPO_VOLUME}:${args.repo} ` : "";
    return `docker run --rm -e RESTIC_PASSWORD='${args.password}' ${creds} ${repoMount}-v ${RESTORE_VOLUME}:/restore ${args.image} -r '${args.repo}'`;
};

// Overwrite a host volume from the snapshot's copy of it (the snapshot stored the read-only mount at
// /volumes/<sub>). Runs as a throwaway sh container over the same restic image.
const restoreVolume = (args: RestoreArgs, volume: string, sub: string): string =>
    `docker run --rm --entrypoint sh -v ${volume}:/dest -v ${RESTORE_VOLUME}:/restore ${args.image} ` +
    `-c 'rm -rf /dest/..?* /dest/.[!.]* /dest/* 2>/dev/null; cp -a /restore/volumes/${sub}/. /dest/'`;

const wants = (scope: RestoreScope, part: "forgejo" | "komodo"): boolean => scope === "all" || scope === part;

// Restore the control plane from a restic snapshot, then leave the operator to `intentic apply` so the
// services are recreated on top of the recovered volumes. This is a deliberate one-shot recovery action, not
// a reconcile step: it stops the affected containers, overwrites their data volumes from the snapshot, and
// (for `all`) restores the /opt/intentic host state — none of which is idempotent or convergent. It NEVER
// runs `restic forget`/deletes the repo: the snapshots are the user's data.
export const restoreBackup = async (args: RestoreArgs): Promise<void> => {
    const executor = args.executor ?? sshExecutor;
    const session: SshSession = await executor.connect(args.target);
    const run = async (command: string, what: string): Promise<void> => {
        const result = await session.exec(command);
        if (result.code !== 0) {
            throw new Error(`restore: ${what} failed (exit ${result.code}): ${result.stderr.trim()}`);
        }
    };
    try {
        args.log(`restoring snapshot "${args.snapshot}" (${args.scope}) from ${args.repo}`);
        await run(`docker volume create ${RESTORE_VOLUME}`, "create restore volume");
        await run(`${resticPrefix(args)} restore '${args.snapshot}' --target /restore`, "restic restore");

        if (wants(args.scope, "forgejo")) {
            // Stop Forgejo + its runner, swap the data volume, then let apply restart them.
            await session.exec("docker rm -f intentic-forgejo intentic-forgejo-runner 2>/dev/null || true");
            await run(restoreVolume(args, "intentic-forgejo-data", "forgejo"), "restore forgejo volume");
            args.log("restored Forgejo data volume");
        }
        if (wants(args.scope, "komodo")) {
            // Tear down the whole Komodo compose project, then restore its postgres/keys/ferretdb volumes.
            await session.exec('ids=$(docker ps -aq -f label=com.docker.compose.project=komodo); [ -n "$ids" ] && docker rm -f $ids || true');
            await run(restoreVolume(args, "komodo_postgres-data", "komodo-postgres"), "restore komodo postgres volume");
            await run(restoreVolume(args, "komodo_keys", "komodo-keys"), "restore komodo keys volume");
            await run(restoreVolume(args, "komodo_ferretdb-state", "komodo-ferretdb"), "restore komodo ferretdb volume");
            args.log("restored Komodo data volumes");
        }
        if (args.scope === "all") {
            // The host-side tokens + compose secrets, so the recovered DBs match their persisted credentials.
            await run(
                `docker run --rm --entrypoint sh -v /opt/intentic:/dest -v ${RESTORE_VOLUME}:/restore ${args.image} ` +
                    "-c 'cp -a /restore/host-opt-intentic/. /dest/'",
                "restore /opt/intentic state",
            );
            args.log("restored /opt/intentic host state");
        }
        // Drop the scratch restore volume; the repo + snapshots are untouched.
        await session.exec(`docker volume rm ${RESTORE_VOLUME} 2>/dev/null || true`);
        args.log('restore complete — run "intentic apply" to bring the services back up on the restored data');
    } finally {
        await session.dispose();
    }
};
