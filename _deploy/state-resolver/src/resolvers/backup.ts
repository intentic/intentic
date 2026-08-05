import { generated } from "@intentic/graph";
import type { BackupInput, HostInput } from "@intentic/need-resolver";
import type { ResolvedNode } from "@intentic/resources";
import { backupId } from "../lib/ids.js";
import { IMAGES } from "../lib/images.js";
import { sshOf } from "../lib/ssh.js";

// The default backup destination when the operator declares no i.have.backup(): a restic repo on a managed
// on-host volume (the backup/restore providers mount intentic-restic-repo at this path, recognised as a
// local repo because it starts with "/") plus an intentic-generated encryption password. Zero external
// setup, so the migration path always exists — a host move streams this volume old->new. An operator who
// wants off-host disaster recovery supplies their own repo via i.have.backup({ repo: "s3:…", … }).
export const DEFAULT_BACKUP_REPO = "/repo";
export const defaultBackupInput = (): BackupInput => ({ repo: DEFAULT_BACKUP_REPO, password: generated("RESTIC_PASSWORD") });

// The scheduled restic backup for a host: one container that, on the declared cron, takes app-consistent
// dumps of the control plane (Forgejo when self-hosted, Komodo always; SignOz when opted in) and pushes
// them to the operator's restic repo. It is deployed onto the host over SSH like the platform services, and
// depends on the control-plane nodes it dumps (`controlPlane`, from the emitter — Komodo only on the hosted
// forges) so the job is installed only once they exist. `signoz` is honoured only when a SignOz service is
// actually declared (nothing to back up otherwise). Secrets (repo password + backend credentials) are
// SecretRefs that serialize as $secret inputs, so collectSecrets carries them into .env.example / adopt.
export const resolveBackup = (
    hostId: string,
    host: HostInput,
    input: BackupInput,
    signozServiceId: string | undefined,
    controlPlane: readonly string[],
): ResolvedNode => {
    const ssh = sshOf(host);
    const signoz = input.signoz === true && signozServiceId !== undefined;
    return {
        id: backupId(hostId),
        type: "backup",
        inputs: {
            ...ssh,
            repo: input.repo,
            password: input.password,
            signoz,
            image: IMAGES.backup,
            ...(input.credentials !== undefined ? { credentials: input.credentials } : {}),
            ...(input.schedule !== undefined ? { schedule: input.schedule } : {}),
            ...(input.retention !== undefined ? { retention: input.retention } : {}),
        },
        explicitDependsOn: [...controlPlane, ...(signoz ? [signozServiceId] : [])],
    };
};
