import type { SshSession } from "../core/ssh.js";
import { REPO_VOLUME } from "./backup.js";

// Cross-machine host migration: the live old host still runs the control plane, but a NAT'd local host opens
// no inbound ports, so the new host cannot pull from it directly. These helpers therefore relay everything
// THROUGH the CLI's two SSH sessions — snapshot on the old host, stream the on-host restic repo old->new, and
// the caller restores it on the new host. The fixed container names mirror the providers that create them
// (forgejo.ts / forgejo-runner.ts / workspace.ts / backup.ts / tunnel.ts).
const BACKUP_CONTAINER = "intentic-backup";
const BACKUP_SCRIPT = "/opt/intentic/backup/backup.sh";
// The scratch tarball the repo volume is packed into on each host (a sibling of the backed-up state, not
// inside /volumes or the repo, so it is never itself captured); removed after the transfer.
const REPO_TAR = "/opt/intentic/migrate-repo.tgz";

// The intentic-managed containers on a host: our named/labelled ones plus Komodo's compose project. Used to
// confirm the old host actually carries a deployment to migrate (and to log what is moving).
export const managedContainers = async (session: SshSession): Promise<string[]> => {
    const ours = (await session.exec('docker ps -a --filter label=intentic.id --format "{{.Names}}"')).stdout;
    const komodo = (await session.exec('docker ps -a --filter label=com.docker.compose.project=komodo --format "{{.Names}}"')).stdout;
    return [...ours.split("\n"), ...komodo.split("\n")].map((name) => name.trim()).filter((name) => name !== "");
};

// Quiesce the old host before the snapshot + cutover: stop the writers (CI runner, agent workspace sandbox) so
// no new control-plane writes race the snapshot, and remove every Cloudflare tunnel connector so the old host
// stops serving public traffic the instant we cut over (no split-brain). Forgejo + Komodo stay UP so the
// snapshot's logical dumps (forgejo dump / pg_dump) are app-consistent. Best-effort — a container may be gone.
export const quiesceHost = async (session: SshSession): Promise<void> => {
    await session.exec("docker stop intentic-forgejo-runner intentic-sandbox-workspace 2>/dev/null || true");
    await session.exec('ids=$(docker ps -aq -f name=intentic-tunnel-); [ -n "$ids" ] && docker rm -f $ids || true');
};

// Take a fresh app-consistent snapshot on the old host by running the on-by-default backup container's own
// script (so the snapshot matches the layout restore expects). Returns whether a fresh snapshot was taken;
// when the backup container is not running the caller falls back to the latest scheduled snapshot.
export const snapshotNow = async (session: SshSession, log: (message: string) => void): Promise<boolean> => {
    const running = (await session.exec(`docker ps --filter "name=^${BACKUP_CONTAINER}$" --format '{{.Names}}'`)).stdout.trim();
    if (running !== BACKUP_CONTAINER) {
        log(`${BACKUP_CONTAINER} is not running on the old host — migrating from the latest existing snapshot instead`);
        return false;
    }
    const result = await session.exec(`docker exec ${BACKUP_CONTAINER} /bin/sh ${BACKUP_SCRIPT}`);
    if (result.code !== 0) {
        throw new Error(`migrate: on-demand snapshot failed (exit ${result.code}): ${result.stderr.trim()}`);
    }
    log("took a fresh restic snapshot on the old host");
    return true;
};

// Move the on-host restic repo from the old host to the new one through the CLI: pack the repo volume into a
// single tarball on the old host (a throwaway container off the restic image, already present), SFTP it down
// then up (streamed, binary-safe), and unpack it into the new host's repo volume — so a local-repo restore on
// the new host reads a repo that is present before it runs. `localTarPath` is the CLI's scratch file.
export const streamRepoVolume = async (
    oldSession: SshSession,
    newSession: SshSession,
    image: string,
    localTarPath: string,
    log: (message: string) => void,
): Promise<void> => {
    if (oldSession.download === undefined || newSession.upload === undefined) {
        throw new Error("migrate: the SSH executor cannot transfer files (no SFTP download/upload) — cannot stream the repo");
    }
    const pack = await oldSession.exec(
        `docker run --rm --entrypoint sh -v ${REPO_VOLUME}:/repo:ro -v /opt/intentic:/out ${image} -c 'tar czf /out/migrate-repo.tgz -C /repo .'`,
    );
    if (pack.code !== 0) {
        throw new Error(`migrate: failed to pack the repo on the old host (exit ${pack.code}): ${pack.stderr.trim()}`);
    }
    await newSession.exec("mkdir -p /opt/intentic");
    await oldSession.download(REPO_TAR, localTarPath);
    await newSession.upload(localTarPath, REPO_TAR);
    const unpack = await newSession.exec(
        `docker run --rm --entrypoint sh -v ${REPO_VOLUME}:/repo -v /opt/intentic:/in ${image} -c 'mkdir -p /repo && tar xzf /in/migrate-repo.tgz -C /repo'`,
    );
    if (unpack.code !== 0) {
        throw new Error(`migrate: failed to unpack the repo on the new host (exit ${unpack.code}): ${unpack.stderr.trim()}`);
    }
    await oldSession.exec(`rm -f ${REPO_TAR}`);
    await newSession.exec(`rm -f ${REPO_TAR}`);
    log("streamed the restic repo from the old host to the new host");
};
