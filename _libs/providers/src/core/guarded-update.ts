import type { SshSession } from "./ssh.js";

// The restic env-file the backup provider writes (RESTIC_PASSWORD + backend creds). A guarded update reuses
// it rather than re-threading the secrets onto every service node.
const RESTIC_ENV = "/opt/intentic/backup/restic.env";

export interface GuardedUpdateOpts {
    readonly session: SshSession;
    readonly repo: string;
    readonly resticImage: string;
    // The host volumes to snapshot before the update and restore on rollback.
    readonly volumes: readonly string[];
    // A unique restic tag for this attempt's snapshot (so rollback restores exactly it).
    readonly tag: string;
    // Bring the service up on the NEW image and wait for health; MUST throw if it does not become healthy.
    readonly recreate: () => Promise<void>;
    // Remove the (possibly unhealthy) container(s) so the data volumes are not in use during restore.
    readonly stop: () => Promise<void>;
    // Bring the service back up on the OLD image and wait for health.
    readonly rollback: () => Promise<void>;
    readonly log: (message: string) => void;
}

const resticRun = (opts: GuardedUpdateOpts, volume: string, mode: ":ro" | "", args: string): string =>
    `docker run --rm --env-file ${RESTIC_ENV} -v ${volume}:/v${mode} ${opts.resticImage} -r '${opts.repo}' ${args}`;

// Wrap a stateful service's image bump in a transaction: snapshot the volumes, try the new image, and on a
// health failure roll the image AND the data back to the pre-update state, then rethrow. The snapshot taken
// moments before is a known-good recovery point, so restoring it undoes even an irreversible on-start schema
// migration the new version may have run — which image-only rollback could not. If the snapshot cannot be
// taken (e.g. backup not applied yet, so restic.env is missing), the update aborts BEFORE touching the
// running service, so a guarded service is never updated without a recovery point.
export const guardedUpdate = async (opts: GuardedUpdateOpts): Promise<void> => {
    for (const volume of opts.volumes) {
        const snapshot = await opts.session.exec(resticRun(opts, volume, ":ro", `backup /v --tag ${opts.tag}`));
        if (snapshot.code !== 0) {
            throw new Error(
                `guarded update: pre-update snapshot of ${volume} failed (exit ${snapshot.code}): ${snapshot.stderr.trim()} — ` +
                    "refusing to update without a recovery point (is i.have.backup applied?)",
            );
        }
    }
    opts.log(`guarded update: snapshotted ${opts.volumes.length} volume(s) as tag "${opts.tag}"`);
    try {
        await opts.recreate();
    } catch (error) {
        opts.log(`guarded update: new image failed health — rolling back image + data: ${String(error)}`);
        await opts.stop();
        for (const volume of opts.volumes) {
            // Restore the snapshot's copy of /v back into the (now-stopped) live volume.
            await opts.session.exec(resticRun(opts, volume, "", `restore latest --tag ${opts.tag} --target /`));
        }
        await opts.rollback();
        throw error;
    }
};
