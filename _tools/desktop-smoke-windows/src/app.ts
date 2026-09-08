// Installing, starting and stopping the app under test. Everything here discovers its target (registry, directory
// listing, `UninstallString`) rather than hardcoding a path, since a wrong guess and a failed install produce the same
// missing file.

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { powershell, type RunResult } from "./run.js";

/** How long an install may take; generous since it may fetch the WebView2 runtime on a machine without one. */
const INSTALL_TIMEOUT_MS = 15 * 60 * 1_000;

// Runs the installer via Start-Process -Wait, not a direct spawn: NSIS's /S returns before a chained WebView2
// bootstrapper finishes, so a direct spawn exits 0 with nothing installed yet.
export const installSilently = async (installer: string): Promise<RunResult> =>
    await powershell(
        `$p = Start-Process -FilePath '${installer}' -ArgumentList '/S' -Wait -PassThru
         Write-Output $p.ExitCode
         exit $p.ExitCode`,
        { timeoutMs: INSTALL_TIMEOUT_MS },
    );

// Runs Windows' own UninstallString through a shell rather than splitting it by hand (it may carry arguments and
// quoting); /S appended for a silent run.
export const uninstallSilently = async (uninstallString: string): Promise<RunResult> =>
    await powershell(
        `$p = Start-Process -FilePath '${uninstallString.replace(/^"|"$/g, ``)}' -ArgumentList '/S' -Wait -PassThru
         Write-Output $p.ExitCode
         exit $p.ExitCode`,
        { timeoutMs: INSTALL_TIMEOUT_MS },
    );

/** The app's own executable inside an install directory, everything but the uninstaller. */
export const appExecutable = async (installLocation: string): Promise<string | undefined> => {
    const entries = await readdir(installLocation, { withFileTypes: true });
    const executable = entries.find(
        (entry) => entry.isFile() && entry.name.toLowerCase().endsWith(`.exe`) && !entry.name.toLowerCase().startsWith(`uninstall`),
    );
    return executable === undefined ? undefined : join(installLocation, executable.name);
};

// Starts the app detached through the shell; -WindowStyle Hidden hides the launching PowerShell, not the app, which
// manages its own window.
export const launchApp = async (executable: string): Promise<RunResult> =>
    await powershell(`Start-Process -FilePath '${executable}' -WindowStyle Hidden`);

/**
 * Whether any process is running from this executable, matched on the image path so a same-named app elsewhere isn't
 * it.
 */
export const appRunning = async (executable: string): Promise<boolean> => {
    const result = await powershell(
        `$ErrorActionPreference='SilentlyContinue'
         $found = Get-Process | Where-Object { $_.Path -eq '${executable}' }
         if ($found) { Write-Output 'true' } else { Write-Output 'false' }`,
    );
    return result.stdout.trim() === `true`;
};

// Ends every process running from this executable. Callers assert this rather than assume it: a leftover window from an
// earlier phase would let a cold-start tier pass without starting anything.
export const quitApp = async (executable: string): Promise<void> => {
    await powershell(
        `$ErrorActionPreference='SilentlyContinue'
         Get-Process | Where-Object { $_.Path -eq '${executable}' } | Stop-Process -Force`,
    );
};
