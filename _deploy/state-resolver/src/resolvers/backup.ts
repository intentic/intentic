import { generated } from "@intentic/graph";
import type { BackupInput, HostInput } from "@intentic/need-resolver";
import type { ResolvedNode } from "@intentic/resources";
import { backupId } from "../lib/ids.js";
import { IMAGES } from "../lib/images.js";
import { sshOf } from "../lib/ssh.js";

// Default restic repo path; recognized as local because it starts with "/" (mounted at intentic-restic-repo).
export const DEFAULT_BACKUP_REPO = "/repo";
export const defaultBackupInput = (): BackupInput => ({ repo: DEFAULT_BACKUP_REPO, password: generated("RESTIC_PASSWORD") });

// Scheduled restic backup for a host: dumps the control plane (Forgejo if self-hosted, Komodo always, SigNoz if
// opted in and declared) on cron. Depends on the control-plane nodes so it installs once they exist; secrets serialize
// as $secret inputs.
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
