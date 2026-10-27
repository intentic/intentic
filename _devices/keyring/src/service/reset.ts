import type { LinuxServicePaths } from "./linux/paths-linux.js";
import { SERVICE_USER } from "./linux/paths-linux.js";
import type { WindowsServicePaths } from "./windows/paths-windows.js";

// Starting Passwords over on a computer whose vault can no longer be opened (its recovery key lost): the service
// stopped, every file in its vault folder moved into a set-aside folder inside it, and the service started again with
// no vault, ready to be set up. Nothing is deleted: the set-aside vault still opens with its old recovery key, by an
// administrator putting its files back. These are the scripts an administrator runs for it (intentic-machine's
// `keyring reset`, through UAC or pkexec); they take no input but paths this package computes.

/** The set-aside folder's name, by when: sortable, and a legal file name on both systems. Pure. */
export const setAsideName = (at: Date): string => `set-aside-${at.toISOString().replace(/\.\d+Z$/u, "Z").replaceAll(":", "-")}`;

const psQuoted = (text: string): string => `'${text.replaceAll("'", "''")}'`;
const shQuoted = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

/** Windows PowerShell, run elevated: the scheduled task stopped, the vault's files moved aside, the task started. Pure. */
export const windowsResetScript = (paths: WindowsServicePaths, aside: string): string => `$ErrorActionPreference = 'Stop'
$vault = ${psQuoted(paths.vaultDir)}
$aside = Join-Path $vault ${psQuoted(aside)}
Stop-ScheduledTask -TaskPath ${psQuoted(paths.taskPath)} -TaskName ${psQuoted(paths.taskName)} -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $aside -Force | Out-Null
foreach ($file in Get-ChildItem -LiteralPath $vault -File) {
  # The stopped service lets go of its files a moment after the task says it stopped.
  for ($try = 1; ; $try++) {
    try { Move-Item -LiteralPath $file.FullName -Destination $aside; break }
    catch { if ($try -ge 20) { throw }; Start-Sleep -Milliseconds 500 }
  }
}
Start-ScheduledTask -TaskPath ${psQuoted(paths.taskPath)} -TaskName ${psQuoted(paths.taskName)}
`;

/** sh, run by pkexec: the unit stopped, the vault's files moved aside (kept the service user's, 0700), the unit started. Pure. */
export const linuxResetScript = (paths: LinuxServicePaths, aside: string): string => {
    const folder = shQuoted(`${paths.vaultDir}/${aside}`);
    return [
        "set -e",
        `systemctl stop ${shQuoted(paths.unitName)}`,
        `mkdir -m 0700 ${folder}`,
        `find ${shQuoted(paths.vaultDir)} -mindepth 1 -maxdepth 1 -type f -exec mv -t ${folder} -- {} +`,
        `chown ${SERVICE_USER}: ${folder}`,
        `systemctl start ${shQuoted(paths.unitName)}`,
    ].join("\n");
};
